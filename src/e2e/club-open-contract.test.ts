import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context, Telegraf } from 'telegraf';
import { ClubRepository } from '../storage/repositories/club.repository';
import { ClubCreationRequestRepository } from '../storage/repositories/club-creation-request.repository';
import { ClubContextManager } from '../app/club-context-manager';
import { SessionContextService, SessionMode } from '../bot/session/session-context.service';
import { CallbackAuthorizationService } from '../bot/authorization/callback-authorization.service';
import { ClubHealthService } from '../domain/clubs/club-health.service';
import { AdminNavigationService } from '../bot/navigation/admin-navigation.service';
import { AdminUi } from '../bot/admin/ui/admin-ui';
import { AdminFlowService } from '../bot/admin/flows/admin-flow.service';
import { ClubManagementHandler } from '../bot/handlers/club-management.handler';
import { ApplicationContext } from '../app/application.context';

test('real application runtime can be constructed after its club context loads', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'club-runtime-contract-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const application = await ApplicationContext.create({ botToken: '1:test', dataDir: root, superAdminIds: [99], defaultTimezone: 'Europe/Kyiv' });
    const club = await application.clubs.create({ name: 'WBC', slug: 'wbc', firstAdminTelegramId: 99 });
    const context = await application.clubContexts.getClubContext(club.id);
    assert.equal(context.clubId, club.id);
    await context.services.chats.create({ id: -1001, name: 'Configured', enabled: true });
    await context.services.templates.create({ clubId: club.id, chatId: -1001, title: 'Automatic', placesLimit: 12, minPlayers: 2, publishDaysBefore: 1, publishTime: '12:00', enabled: true, slots: [{ dayOfWeek: 3, startTime: '19:00', endTime: '21:00', enabled: true }] });

    const runtime = await (application as unknown as {
        getClubRuntime(clubId: string): Promise<{ context: { clubId: string; services: { scheduler: { getScheduledTemplateIds(): string[]; cancelAll(): void } } } }>;
        invalidateClubRuntime(clubId: string): void;
    }).getClubRuntime(club.id);
    assert.equal(runtime.context.clubId, club.id);
    assert.equal(runtime.context.services.scheduler.getScheduledTemplateIds().filter((id) => id.includes(':template:')).length, 1);

    (application as unknown as { invalidateClubRuntime(clubId: string): void }).invalidateClubRuntime(club.id);
    const reloaded = await (application as unknown as {
        getClubRuntime(clubId: string): Promise<{ context: { services: { scheduler: { getScheduledTemplateIds(): string[]; cancelAll(): void } } } }>;
    }).getClubRuntime(club.id);
    assert.equal(reloaded.context.services.scheduler.getScheduledTemplateIds().filter((id) => id.includes(':template:')).length, 1);
    reloaded.context.services.scheduler.cancelAll();
});

test('successful ClubRuntimeContext opens the same club and renders its root', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'club-open-contract-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root); const club = await clubs.create({ name: 'WBC', slug: 'wbc', firstAdminTelegramId: 99 });
    const requests = new ClubCreationRequestRepository(path.join(root, '_system', 'requests.json')); await requests.load();
    const sessions = new SessionContextService(); sessions.enterSuperAdmin(99);
    const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs, sessions); const acquired = await manager.getClubContext(club.id); assert.equal(acquired.clubId, club.id);
    let renderedClubId: string | undefined;
    const handler = createHandler(clubs, requests, sessions, root, async (clubId) => { const context = await manager.getClubContext(clubId); const settings = await context.repositories.settings.get(); return { clubId: context.clubId, title: context.title, storageSlug: context.storageSlug, directoryPath: context.directoryPath, settingsPath: context.repositories.settings.getFilePath(), settingsClubId: settings.clubId }; }, async (_ctx, clubId) => { renderedClubId = clubId; });
    const replies: string[] = []; await handler.handleCallback(callbackContext(`mode:club:${club.shortId}`, replies));
    assert.equal(sessions.get(99)?.mode, SessionMode.CLUB_ADMIN); assert.equal(sessions.get(99)?.activeClubId, club.id); assert.equal(renderedClubId, club.id); assert.equal(replies.some((text) => text.includes('Не вдалося завантажити дані клубу')), false);
});

test('failure after context acquisition is a root-render failure, not repository failure', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'club-open-stage-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const clubs = new ClubRepository(root); const club = await clubs.create({ name: 'WBC', slug: 'wbc', firstAdminTelegramId: 99 }); const requests = new ClubCreationRequestRepository(path.join(root, '_system', 'requests.json')); await requests.load(); const sessions = new SessionContextService(); sessions.enterSuperAdmin(99); const manager = new ClubContextManager(root, 'Europe/Kyiv', clubs, sessions);
    const handler = createHandler(clubs, requests, sessions, root, async (clubId) => { const context = await manager.getClubContext(clubId); const settings = await context.repositories.settings.get(); return { clubId: context.clubId, title: context.title, storageSlug: context.storageSlug, directoryPath: context.directoryPath, settingsPath: context.repositories.settings.getFilePath(), settingsClubId: settings.clubId }; }, async () => { throw new Error('root boom'); });
    const replies: string[] = []; await handler.handleCallback(callbackContext(`mode:club:${club.shortId}`, replies)); assert.equal(sessions.get(99)?.activeClubId, club.id); assert.match(replies.at(-1)!, /Дані клубу завантажено, але меню/); assert.equal(replies.at(-1)!.includes('дані клубу.\n\nКлуб:'), false);
});

function createHandler(clubs: ClubRepository, requests: ClubCreationRequestRepository, sessions: SessionContextService, root: string, prepare: ConstructorParameters<typeof ClubManagementHandler>[8], render: ConstructorParameters<typeof ClubManagementHandler>[9]) { const bot = new Telegraf('1:test'); bot.telegram.deleteMessage = (async () => true) as typeof bot.telegram.deleteMessage; const authorization = new CallbackAuthorizationService(clubs, requests, [99], sessions); const navigation = new AdminNavigationService(sessions, new AdminUi(sessions), new AdminFlowService()); return new ClubManagementHandler(bot, clubs, requests, [99], authorization, sessions, new ClubHealthService(clubs, root), navigation, prepare, render); }
function callbackContext(data: string, replies: string[]): Context { return { from: { id: 99, is_bot: false, first_name: 'Super' }, chat: { id: 99, type: 'private' }, callbackQuery: { id: 'q', chat_instance: 'i', from: { id: 99, is_bot: false, first_name: 'Super' }, data }, update: { update_id: 1 }, telegram: { deleteMessage: async () => true }, answerCbQuery: async () => true, reply: async (text: string) => { replies.push(text); return { message_id: replies.length } as never; } } as unknown as Context; }
