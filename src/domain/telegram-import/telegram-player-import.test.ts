import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlayersRepository } from '../../storage/repositories/players.repository';
import { TelegramPlayerImportService } from './telegram-player-import.service';
import { TelegramSessionCipher } from './telegram-session-cipher';
import { TelegramImportSource } from './telegram-user-connection.types';
import { TelegramUserConnectionRepository } from '../../storage/repositories/telegram-user-connection.repository';

const source = (clubId: string): TelegramImportSource => ({ id: 'source-a', shortId: 'srcA', clubId, connectionId: 'connection-a', telegramChatId: '-1001', title: 'Club group', addedBy: 10, createdAt: new Date().toISOString() });

test('encrypted sessions round-trip without storing plaintext', () => {
    const cipher = new TelegramSessionCipher('a strong server-only test key');
    const encrypted = cipher.encrypt('secret-session-token');
    assert.equal(cipher.decrypt(encrypted), 'secret-session-token');
    assert.equal(JSON.stringify(encrypted).includes('secret-session-token'), false);
});

test('Telegram preview is club-scoped, additive, explicit and double-confirmation safe', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-import-'));
    const players = new PlayersRepository(path.join(directory, 'players.json'));
    await players.saveAll([{ id: 'existing', displayName: 'Existing Person', telegramUserId: 100, aliases: [], isConfirmed: true, isActive: true, source: 'admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]);
    const manager = { scan: async () => ({
        participants: [
            { telegramUserId: 100, firstName: 'Existing' },
            { telegramUserId: 200, firstName: 'Папаня' },
            { telegramUserId: 300, firstName: '😈' },
            { telegramUserId: 400, firstName: 'Bot', bot: true },
            { telegramUserId: 500, firstName: 'Deleted', deleted: true },
        ],
        contacts: [{ userId: 200, firstName: 'Євген', lastName: 'Мухін' }], partial: false,
    }) };
    let backupCount = 0;
    const service = new TelegramPlayerImportService('club-a', players, manager, async () => { backupCount++; });

    await assert.rejects(() => service.scan(source('club-b'), 10), /CLUB_CONTEXT_MISMATCH/);
    const preview = await service.scan(source('club-a'), 10);
    assert.equal((await players.list()).length, 1, 'scan must not mutate PlayersRepository');
    assert.equal(preview.existingCount, 1);
    assert.equal(preview.plan.newCount, 1);
    assert.equal(preview.reviewCount, 1);
    assert.equal(preview.canCommit, false);
    assert.equal(preview.skippedCount, 2);
    await assert.rejects(() => service.commit(preview.id, 'club-b', 10), /TELEGRAM_IMPORT_SESSION_STALE/);

    await assert.rejects(() => service.commit(preview.id, 'club-a', 10), /IMPORT_PLAN_BLOCKED/);
    const ready = service.skipProblematic(preview.id, 'club-a', 10);
    assert.equal(ready.canCommit, true);
    const committed = await service.commit(preview.id, 'club-a', 10);
    assert.deepEqual(committed, { created: 1, updated: 0, unchanged: 0 });
    assert.equal(backupCount, 1);
    const stored = await players.list();
    assert.equal(stored.length, 2);
    assert.ok(stored.some((player) => player.telegramUserId === 100), 'existing players are never removed');
    const imported = stored.find((player) => player.telegramUserId === 200)!;
    assert.equal(imported.displayName, 'Євген Мухін');
    assert.deepEqual(imported.aliases, ['Папаня']);
    assert.equal(imported.isConfirmed, true);

    assert.deepEqual(await service.commit(preview.id, 'club-a', 10), { created: 0, updated: 0, unchanged: 1 });
    assert.equal((await players.list()).length, 2);
    assert.equal(backupCount, 1);
});

test('blocked Telegram candidates require review, then bulk skip rebuilds readiness and imports safe rows', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-import-review-'));
    const players = new PlayersRepository(path.join(directory, 'players.json'));
    await players.saveAll([
        { id: 'dup-a', displayName: 'Possible A', aliases: [], isConfirmed: true, isActive: true, source: 'admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'dup-b', displayName: 'Possible B', aliases: [], isConfirmed: true, isActive: true, source: 'admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const participants = [
        ...Array.from({ length: 10 }, (_, index) => ({ telegramUserId: 1_000 + index, firstName: `New ${index}` })),
        { telegramUserId: 2_001, firstName: 'Possible A' }, { telegramUserId: 2_002, firstName: 'Possible B' },
    ];
    const service = new TelegramPlayerImportService('club-a', players, { scan: async () => ({ participants, contacts: [], partial: false }) }, async () => undefined);
    const preview = await service.scan(source('club-a'), 10);
    assert.equal(preview.plan.newCount, 10); assert.equal(preview.possibleDuplicateCount, 2); assert.equal(preview.canCommit, false);
    await assert.rejects(() => service.commit(preview.id, 'club-a', 10), /IMPORT_PLAN_BLOCKED/);
    const ready = service.skipProblematic(preview.id, 'club-a', 10);
    assert.equal(ready.skippedCount, 2); assert.equal(ready.canCommit, true);
    assert.deepEqual(await service.commit(preview.id, 'club-a', 10), { created: 10, updated: 0, unchanged: 0 });
});

test('bulk skip cannot bypass a hard duplicate identity/name conflict', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-import-hard-conflict-'));
    const players = new PlayersRepository(path.join(directory, 'players.json'));
    const service = new TelegramPlayerImportService('club-a', players, { scan: async () => ({ participants: [
        { telegramUserId: 1, firstName: 'Same Name' }, { telegramUserId: 2, firstName: 'Same Name' },
    ], contacts: [], partial: false }) }, async () => undefined);
    const preview = await service.scan(source('club-a'), 10);
    assert.equal(preview.plan.conflictCount, 1); assert.equal(preview.canCommit, false);
    const afterSkip = service.skipProblematic(preview.id, 'club-a', 10);
    assert.equal(afterSkip.canCommit, false); assert.ok(afterSkip.blockingTypes.includes('AMBIGUOUS_MATCH'));
    await assert.rejects(() => service.commit(preview.id, 'club-a', 10), /IMPORT_PLAN_BLOCKED/);
});

test('connection metadata persists across restart and remains isolated by club', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-connections-'));
    const file = path.join(directory, 'telegram-user-connections.json');
    const first = new TelegramUserConnectionRepository(file);
    const now = new Date().toISOString();
    await first.save({ id: 'a', shortId: 'a1', clubId: 'club-a', telegramUserId: 10, displayName: 'Admin A', sessionStorageKey: 'a1.json', connectedAt: now, lastValidatedAt: now, status: 'connected' });
    await first.save({ id: 'b', shortId: 'b1', clubId: 'club-b', telegramUserId: 20, displayName: 'Admin B', sessionStorageKey: 'b1.json', connectedAt: now, lastValidatedAt: now, status: 'connected' });

    const afterRestart = new TelegramUserConnectionRepository(file);
    assert.deepEqual((await afterRestart.listByClub('club-a')).map((item) => item.telegramUserId), [10]);
    assert.deepEqual((await afterRestart.listByClub('club-b')).map((item) => item.telegramUserId), [20]);
    const persisted = await fs.readFile(file, 'utf8');
    assert.equal(persisted.includes('secret-session-token'), false);
});
