import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, rename, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClubContextManager } from '../app/club-context-manager';
import { ClubContextLoadError } from '../app/club-context-manager';
import { ClubRepository } from '../storage/repositories/club.repository';
import { SessionContextService } from '../bot/session/session-context.service';
import { ClubHealthService } from '../domain/clubs/club-health.service';
import { TemplateSchedulerService } from '../domain/templates/template-scheduler.service';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { ClubDiagnosticsService } from '../domain/clubs/club-diagnostics.service';

test('lazy multi-club contexts, persisted statistics, switching and restart stay isolated', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-multiclub-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root);
    const a = await clubs.create({ name: 'Бадмінтон Київ', slug: 'badminton-kyiv', firstAdminTelegramId: 1 });
    const b = await clubs.create({ name: 'RSP Kyoto', slug: 'rsp-kyoto', firstAdminTelegramId: 2 });
    const c = await clubs.create({ name: 'WBC', slug: 'wbc', firstAdminTelegramId: 3 });
    const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs, new SessionContextService());
    assert.equal(manager.hasClubContext(a.id), false);

    const ca = await manager.getClubContext(a.id);
    await ca.services.chats.create({ id: -101, name: 'A' });
    await createTemplates(ca, 1);
    const cb = await manager.getClubContext(b.id);
    await cb.services.chats.create({ id: -201, name: 'B1' });
    await cb.services.chats.create({ id: -202, name: 'B2' });
    const cc = await manager.getClubContext(c.id);
    await cc.services.chats.create({ id: -301, name: 'C' });
    await createTemplates(cc, 3);

    assert.notEqual(ca.services, cb.services);
    assert.notEqual(ca.repositories, cb.repositories);
    assert.deepEqual((await ca.services.chats.getAll()).map((chat) => chat.name), ['A']);
    assert.deepEqual((await cb.services.chats.getAll()).map((chat) => chat.name), ['B1', 'B2']);
    assert.deepEqual((await (await manager.getClubContext(a.id)).services.chats.getAll()).map((chat) => chat.name), ['A']);

    const restarted = new ClubContextManager(root, 'Europe/Kyiv', clubs, new SessionContextService());
    const health = new ClubHealthService(clubs, root, 30, restarted);
    const stats = new Map((await health.inspectAll()).map((item) => [item.club.slug, item]));
    assert.deepEqual([stats.get('badminton-kyiv')?.chats, stats.get('badminton-kyiv')?.enabledTemplates], [1, 1]);
    assert.deepEqual([stats.get('rsp-kyoto')?.chats, stats.get('rsp-kyoto')?.enabledTemplates], [2, 0]);
    assert.deepEqual([stats.get('wbc')?.chats, stats.get('wbc')?.enabledTemplates], [1, 3]);
    assert.equal((await restarted.getClubContext(b.id)).clubId, b.id);
});

test('settings clubId mismatch fails without falling back and health is unavailable rather than empty', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-mismatch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root);
    const club = await clubs.create({ name: 'Mismatch', slug: 'mismatch', firstAdminTelegramId: 1 });
    const setup = new ClubContextManager(root, 'Europe/Kyiv', clubs);
    const context = await setup.getClubContext(club.id);
    const settings = await context.repositories.settings.get();
    await context.repositories.settings.save({ ...settings, clubId: 'wrong-club' });
    const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs);
    await assert.rejects(() => manager.getClubContext(club.id), /does not match/);
    assert.equal(manager.hasClubContext(club.id), false);
    const result = await new ClubHealthService(clubs, root, 30, manager).inspect(club);
    assert.equal(result.dataAvailable, false);
    assert.equal(result.status, 'broken');
});

test('missing storage and corrupt settings return specific failures without creating empty club data', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-context-failures-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root);
    const missing = await clubs.create({ name: 'Missing', slug: 'missing', firstAdminTelegramId: 1 });
    await rename(path.join(root, 'missing'), path.join(root, 'old-missing'));
    await assert.rejects(new ClubContextManager(root, 'Europe/Kyiv', clubs).getClubContext(missing.id), (error) => error instanceof ClubContextLoadError && error.code === 'STORAGE_NOT_FOUND');
    const corrupt = await clubs.create({ name: 'Corrupt', slug: 'corrupt', firstAdminTelegramId: 2 });
    await writeFile(path.join(root, corrupt.slug, 'settings.json'), '{broken', 'utf8');
    await assert.rejects(new ClubContextManager(root, 'Europe/Kyiv', clubs).getClubContext(corrupt.id), (error) => error instanceof ClubContextLoadError && error.code === 'SETTINGS_INVALID');
});

test('stale cached context is invalidated and retried exactly once', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-context-cache-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root); const club = await clubs.create({ name: 'Cached', slug: 'cached', firstAdminTelegramId: 1 });
    const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs); const first = await manager.getClubContext(club.id);
    await rm(path.join(root, club.slug, 'settings.json'));
    await assert.rejects(manager.getClubContext(club.id), (error) => error instanceof ClubContextLoadError && error.code === 'SETTINGS_NOT_FOUND');
    assert.equal(manager.hasClubContext(club.id), false); assert.equal(first.clubId, club.id);
});

test('cache entry keyed as B but containing A is rejected and B is loaded', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-context-cross-key-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root);
    const a = await clubs.create({ name: 'A', slug: 'a', firstAdminTelegramId: 1 });
    const b = await clubs.create({ name: 'B', slug: 'b', firstAdminTelegramId: 2 });
    const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs);
    const aContext = await manager.getClubContext(a.id);
    (manager as unknown as { contexts: Map<string, Promise<typeof aContext>> }).contexts.set(b.id, Promise.resolve(aContext));
    const bContext = await manager.getClubContext(b.id);
    assert.equal(bContext.clubId, b.id);
    assert.equal(bContext.storageSlug, 'b');
    assert.notEqual(bContext.repositories, aContext.repositories);
});

test('scheduler job identity contains its club and uses that club context', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-scheduler-club-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root);
    const club = await clubs.create({ name: 'Scheduler', slug: 'scheduler', firstAdminTelegramId: 1 });
    const context = await new ClubContextManager(root, 'Europe/Kyiv', clubs).getClubContext(club.id);
    await context.services.chats.create({ id: -500, name: 'Scheduler chat' });
    const templates = await createTemplates(context, 1);
    const publisher = { publishTemplateSlot: async () => { throw new Error('not due'); } } as unknown as TrainingPublisherService;
    const scheduler = new TemplateSchedulerService(context.services.templates, context.services.scheduler, publisher, context.services.chats, context.repositories.settings);
    await scheduler.restore(templates);
    const ids = context.services.scheduler.getScheduledTemplateIds();
    assert.equal(ids.length, 1);
    assert.match(ids[0], new RegExp(`^club:${escapeRegExp(club.id)}:template:`));
    context.services.scheduler.cancelAll();
});

test('read-only club diagnostics classify storage, settings, ID and repository failures', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-diagnostics-')); t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root); const club = await clubs.create({ name: 'WBC', slug: 'wbc', firstAdminTelegramId: 1 }); const service = new ClubDiagnosticsService(clubs, root);
    const directory = path.join(root, 'wbc'); const saved = path.join(root, 'saved-wbc');
    await rename(directory, saved); assert.equal((await service.diagnose(club.id)).failure?.code, 'STORAGE_NOT_FOUND'); await assert.rejects(fsStat(directory)); await rename(saved, directory);
    const settingsPath = path.join(directory, 'settings.json'); const originalSettings = await fsRead(settingsPath);
    await rm(settingsPath); assert.equal((await service.diagnose(club.id)).failure?.code, 'SETTINGS_NOT_FOUND'); await assert.rejects(fsStat(settingsPath));
    await writeFile(settingsPath, '{bad', 'utf8'); assert.equal((await service.diagnose(club.id)).failure?.code, 'SETTINGS_INVALID'); assert.equal(await fsRead(settingsPath), '{bad');
    const wrapped = JSON.parse(originalSettings); wrapped.data.clubId = '123'; await writeFile(settingsPath, JSON.stringify(wrapped), 'utf8'); const mismatch = await service.diagnose(club.id); assert.equal(mismatch.failure?.code, 'CLUB_ID_MISMATCH'); assert.equal(mismatch.settingsClubId, '123');
    await writeFile(settingsPath, originalSettings, 'utf8'); const chatsPath = path.join(directory, 'chats.json'); await writeFile(chatsPath, '{boom', 'utf8'); const corrupt = await service.diagnose(club.id); assert.equal(corrupt.failure?.code, 'REPOSITORY_CORRUPT'); assert.equal(corrupt.failure?.repository, 'chats'); assert.equal(await fsRead(chatsPath), '{boom');
});

test('diagnostics preserve unknown errors and a fixed club really reloads', async (t) => {
    const unknownClubs = { findById: async () => { throw new Error('boom'); } } as unknown as ClubRepository; const unknown = await new ClubDiagnosticsService(unknownClubs, '/unused').diagnose('wbc'); assert.equal(unknown.failure?.code, 'UNKNOWN'); assert.equal(unknown.failure?.technicalMessage, 'boom');
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-diagnostic-retry-')); t.after(() => rm(root, { recursive: true, force: true })); const clubs = new ClubRepository(root); const club = await clubs.create({ name: 'WBC', slug: 'wbc', firstAdminTelegramId: 1 }); const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs); const directory = path.join(root, 'wbc'); const saved = path.join(root, 'saved-wbc'); await rename(directory, saved); await assert.rejects(manager.getClubContext(club.id)); await rename(saved, directory); assert.equal((await manager.reloadClubContext(club.id)).clubId, club.id);
});

async function createTemplates(context: Awaited<ReturnType<ClubContextManager['getClubContext']>>, count: number) {
    const result = [];
    for (let index = 0; index < count; index++) {
        result.push(await context.services.templates.create({ clubId: context.clubId, chatId: index < 1 ? (await context.services.chats.getAll())[0]?.id ?? -1 : (await context.services.chats.getAll())[0].id, title: `Template ${index}`, placesLimit: 12, minPlayers: 0, publishDaysBefore: 1, publishTime: '18:00', slots: [{ dayOfWeek: index % 7 + 1, startTime: '19:00', endTime: '21:00' }], enabled: true }));
    }
    return result;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function fsRead(file: string): Promise<string> { return readFile(file, 'utf8'); }
async function fsStat(file: string) { return stat(file); }
