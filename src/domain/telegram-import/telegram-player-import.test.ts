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
    const ready = await service.skipProblematic(preview.id, 'club-a', 10);
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

    await assert.rejects(() => service.commit(preview.id, 'club-a', 10), /IMPORT_ALREADY_COMPLETED/);
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
    const ready = await service.skipProblematic(preview.id, 'club-a', 10);
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
    const afterSkip = await service.skipProblematic(preview.id, 'club-a', 10);
    assert.equal(afterSkip.canCommit, false); assert.ok(afterSkip.blockingTypes.includes('AMBIGUOUS_MATCH'));
    await assert.rejects(() => service.commit(preview.id, 'club-a', 10), /IMPORT_PLAN_BLOCKED/);
});

test('161 new, four ambiguous matches and three review names resolve into a committable rebuilt plan', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-import-ambiguous-'));
    const players = new PlayersRepository(path.join(directory, 'players.json')); const now = '2026-01-01T00:00:00.000Z';
    await players.saveAll(['Alex', 'Sasha', 'Maria', 'Ivan'].flatMap((name, index) => [
        { id: `${name}-a`, displayName: `${name} Primary`, aliases: [name], isConfirmed: true, isActive: true, source: 'admin' as const, createdAt: now, updatedAt: now },
        { id: `${name}-b`, displayName: `${name} Secondary`, aliases: [name], isConfirmed: true, isActive: true, source: 'admin' as const, createdAt: now, updatedAt: now },
    ]));
    const participants = [
        ...Array.from({ length: 161 }, (_, index) => ({ telegramUserId: 10_000 + index, firstName: `New Player ${index}` })),
        ...['Alex', 'Sasha', 'Maria', 'Ivan'].map((firstName, index) => ({ telegramUserId: 20_000 + index, firstName, username: `ambiguous_${index + 1}` })),
        { telegramUserId: 30_001, firstName: '😈' }, { telegramUserId: 30_002, firstName: '!' }, { telegramUserId: 30_003, firstName: 'X' },
    ];
    const service = new TelegramPlayerImportService('club-a', players, { scan: async () => ({ participants, contacts: [], partial: false }) }, async () => undefined);
    const preview = await service.scan(source('club-a'), 10); assert.equal(preview.plan.newCount, 161); assert.equal(preview.reviewCount, 3); assert.equal(preview.plan.conflictCount, 4); assert.equal(preview.blockedCount, 7);
    let current = await service.skipProblematic(preview.id, 'club-a', 10); assert.equal(current.blockedCount, 4); assert.deepEqual(current.blockingTypes, ['AMBIGUOUS_MATCH']);
    const diagnostic: string[] = [];
    for (const [index, decision] of ['merge', 'create', 'skip', 'merge'].entries()) {
        const review = await service.getNextAmbiguous(preview.id, 'club-a', 10); assert.ok(review); diagnostic.push(`${review.telegramUsername}:${review.players.map((player) => player.displayName).join('|')}`);
        if (decision === 'merge') current = await service.resolveAmbiguous(preview.id, 'club-a', 10, review.candidateToken, { type: 'merge_existing', existingPlayerId: review.players[index === 0 ? 0 : 1].id });
        else if (decision === 'create') current = await service.resolveAmbiguous(preview.id, 'club-a', 10, review.candidateToken, { type: 'create_new' });
        else current = await service.resolveAmbiguous(preview.id, 'club-a', 10, review.candidateToken, { type: 'skip' });
    }
    assert.deepEqual(diagnostic, ['ambiguous_1:Alex Primary|Alex Secondary', 'ambiguous_4:Ivan Primary|Ivan Secondary', 'ambiguous_3:Maria Primary|Maria Secondary', 'ambiguous_2:Sasha Primary|Sasha Secondary']);
    assert.equal(current.blockedCount, 0); assert.equal(current.canCommit, true);
    assert.deepEqual(await service.commit(preview.id, 'club-a', 10), { created: 162, updated: 2, unchanged: 0 });
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

test('possible duplicate and suspicious-name review decisions rebuild one canonical plan', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-import-soft-review-')); const players = new PlayersRepository(path.join(directory, 'players.json')); const now = '2026-01-01T00:00:00.000Z';
    await players.saveAll([{ id: 'alex', displayName: 'Alex', aliases: [], isConfirmed: true, isActive: true, source: 'admin', createdAt: now, updatedAt: now }]);
    const service = new TelegramPlayerImportService('club-a', players, { scan: async () => ({ participants: [{ telegramUserId: 11, firstName: 'Alex' }, { telegramUserId: 12, firstName: '😈', username: 'devil' }], contacts: [], partial: false }) }, async () => undefined);
    const preview = await service.scan(source('club-a'), 10); assert.deepEqual(preview.blockingTypes, ['POSSIBLE_DUPLICATE', 'NEEDS_REVIEW']);
    const duplicate = await service.getNextReview(preview.id, 'club-a', 10); assert.equal(duplicate?.type, 'POSSIBLE_DUPLICATE'); assert.equal(duplicate?.players[0].id, 'alex');
    await service.resolveReview(preview.id, 'club-a', 10, duplicate!.candidateToken, { type: 'merge_existing', existingPlayerId: 'alex' });
    const suspicious = await service.getNextReview(preview.id, 'club-a', 10); assert.equal(suspicious?.type, 'NEEDS_REVIEW');
    const ready = await service.resolveReview(preview.id, 'club-a', 10, suspicious!.candidateToken, { type: 'rename_and_create', displayName: 'Олексій' });
    assert.equal(ready.state, 'ready'); assert.equal(ready.canCommit, true); assert.equal(ready.plan.updateCount, 1); assert.equal(ready.plan.newCount, 1);
    assert.deepEqual(await service.commit(preview.id, 'club-a', 10), { created: 1, updated: 1, unchanged: 0 });
    assert.equal((await players.list()).some((player) => player.displayName === 'Олексій' && player.telegramUserId === 12), true);
});

test('review sessions are isolated by requesting user and club and cancelled callbacks become stale', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-import-scope-')); const players = new PlayersRepository(path.join(directory, 'players.json'));
    const service = new TelegramPlayerImportService('club-a', players, { scan: async () => ({ participants: [{ telegramUserId: 1, firstName: '😈' }], contacts: [], partial: false }) }, async () => undefined);
    const preview = await service.scan(source('club-a'), 10);
    assert.throws(() => service.get(preview.id, 'club-a', 11), /TELEGRAM_IMPORT_SESSION_STALE/); assert.throws(() => service.get(preview.id, 'club-b', 10), /TELEGRAM_IMPORT_SESSION_STALE/);
    service.cancel(preview.id, 'club-a', 10); assert.throws(() => service.get(preview.id, 'club-a', 10), /STALE_CALLBACK/);
});
