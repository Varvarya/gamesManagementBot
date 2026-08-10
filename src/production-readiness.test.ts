import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BaseJsonRepository } from './storage/repositories/baseJsonRepository';
import { assertCallbackDataValid } from './bot/callback-data';
import { isTelegramUserClubAdmin } from './domain/settings/club-admin-authorization';
import { TrainingService } from './domain/trainings/training.service';
import { TrainingParticipantsService } from './domain/trainings/training-participants.service';
import { RepositoriesContext } from './app/repositories.context';
import { JsonStorage } from './storage/jsonStorage';

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-readiness-'));
    const storage = new JsonStorage({ dataDir: root, storageSlug: 'club-a' });
    await storage.ensureReady();
    const repositories = new RepositoriesContext(storage, 'Europe/Kyiv', { clubId: 'club-a', title: 'A', storageSlug: 'club-a' });
    await repositories.loadAll();
    return { root, repositories };
}

test('authorization normalizes IDs and accepts owners and admins', () => {
    const admins = [{ telegramUserId: '42', role: 'owner' }, { telegramUserId: 43, role: 'admin' }];
    assert.equal(isTelegramUserClubAdmin(admins, 42), true);
    assert.equal(isTelegramUserClubAdmin(admins, '43'), true);
    assert.equal(isTelegramUserClubAdmin(admins, 44), false);
});

test('callback_data enforces Telegram UTF-8 byte limit', () => {
    assert.equal(assertCallbackDataValid('x'.repeat(64)), 'x'.repeat(64));
    assert.throws(() => assertCallbackDataValid('🏸'.repeat(17)), /bytes=68/);
});

test('repository returns isolated values and persists an explicit mutation', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-repo-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'entities.json');
    const repository = new BaseJsonRepository<{ id: string; nested: { value: number } }>(file);
    await repository.save({ id: 'one', nested: { value: 1 } });
    const leaked = (await repository.list())[0];
    leaked.nested.value = 99;
    assert.equal((await repository.findById('one'))?.nested.value, 1);
    assert.match(await readFile(file, 'utf8'), /"value": 1/);
});

test('capacity uses places, keeps an entry whole, decrements, and skips oversized waitlist entries', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const trainings = new TrainingService(repositories);
    const participants = new TrainingParticipantsService(trainings);
    const draft = await trainings.createDraft({ clubId: 'club-a', chatId: -1, title: 'Game', date: '2030-01-01', startTime: '18:00', endTime: '20:00', placesLimit: 6, minPlayers: 0 });
    await trainings.publish({ trainingId: draft.id, messageId: 1 });
    await participants.addParticipant({ trainingId: draft.id, playerId: 'a', displayName: 'A', places: 4, source: 'telegram' });
    assert.equal((await participants.addParticipant({ trainingId: draft.id, playerId: 'b', displayName: 'B', places: 3, source: 'telegram' })).outcome, 'waitlisted');
    await participants.addParticipant({ trainingId: draft.id, playerId: 'c', displayName: 'C', places: 1, source: 'telegram' });
    await participants.addParticipant({ trainingId: draft.id, playerId: 'd', displayName: 'D', places: 2, source: 'telegram' });
    const result = await participants.removeParticipant({ trainingId: draft.id, playerId: 'a', requestedPlacesToRemove: 1 });
    assert.deepEqual(result.promotedPlayerIds, ['d']);
    assert.equal(result.training.participants.reduce((sum, entry) => sum + entry.places, 0), 6);
    assert.deepEqual(result.training.waitlist.map((entry) => entry.playerId), ['b']);
});

test('training lifecycle rejects impossible transitions', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = new TrainingService(repositories);
    const draft = await service.createDraft({ clubId: 'club-a', chatId: -1, title: 'Game', date: '2030-01-01', startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 8 });
    await assert.rejects(() => service.finish(draft.id), /Invalid training transition/);
    await service.publish({ trainingId: draft.id, messageId: 1 });
    await service.close(draft.id);
    assert.equal((await service.finish(draft.id)).status, 'finished');
    assert.equal((await service.archive(draft.id)).status, 'archived');
});
