import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlayersRepository } from '../../storage/repositories/players.repository';
import { PlayerCsvParser } from './player-csv';
import { PlayerImportService } from './player-import.service';
import { PlayerExportService } from './player-export.service';
import { Player } from './player.types';
import { PlayerService } from './player.service';
import { RepositoriesContext } from '../../app/repositories.context';
import { Training } from '../trainings/training.types';

test('CSV parser supports minimal, BOM, semicolon, aliases and row errors', () => {
    const parser = new PlayerCsvParser();
    assert.equal(parser.parse('displayName\nМарія\nОлександр\nЄвген\n\n').rows.length, 3);
    const excel = parser.parse('\uFEFFdisplayName;telegramUserId;aliases;confirmed;active\nМарія;123;"Маша|Марія✨";yes;0\n');
    assert.equal(excel.delimiter, ';');
    assert.deepEqual(excel.rows[0], { rowNumber: 2, displayName: 'Марія', telegramUserId: 123, telegramUsername: undefined, aliases: ['Маша', 'Марія✨'], confirmed: true, active: false });
    const invalid = parser.parse('displayName,telegramUserId,confirmed\n,123,true\nЄва,nope,true\nЖеня,123,maybe\n');
    assert.deepEqual(invalid.errors.map((error) => error.rowNumber), [2, 3, 4]);
});

test('additive import is idempotent and exported CSV re-imports unchanged', async (t) => {
    const h = await repositoryHarness(t, 'repeat');
    const importer = new PlayerImportService('a', h, async () => undefined);
    const csv = 'displayName\nМарія\nОлександр\nЄвген\n';
    const first = await importer.preview(csv);
    assert.equal(first.newCount, 3);
    await importer.commit(first);
    const second = await importer.preview(csv);
    assert.deepEqual([second.newCount, second.updateCount, second.unchangedCount], [0, 0, 3]);
    await importer.commit(second);
    const exported = await new PlayerExportService('a', 'Club A', h).csv();
    const roundTrip = await importer.preview(exported);
    assert.deepEqual([roundTrip.newCount, roundTrip.updateCount, roundTrip.unchangedCount], [0, 0, 3]);
    assert.equal((await h.list()).length, 3);
});

test('Telegram ID match preserves canonical name and empty fields preserve identity', async (t) => {
    const h = await repositoryHarness(t, 'identity');
    await h.save(player({ id: 'maria', displayName: 'Марія✨', telegramUserId: 123, aliases: ['Маша'], isConfirmed: true }));
    const importer = new PlayerImportService('identity', h, async () => undefined);
    const plan = await importer.preview('displayName,telegramUserId,telegramUsername,aliases,confirmed,active\nМарія,123,,Евгений,,\n');
    await importer.commit(plan);
    const saved = (await h.findById('maria'))!;
    assert.equal(saved.displayName, 'Марія✨');
    assert.equal(saved.telegramUserId, 123);
    assert.equal(saved.isConfirmed, true);
    assert.deepEqual(saved.aliases, ['Маша', 'Марія', 'Евгений']);
});

test('explicit deactivation preserves the player record', async (t) => {
    const h = await repositoryHarness(t, 'inactive');
    await h.save(player({ id: 'p', displayName: 'Євген', isActive: true }));
    const importer = new PlayerImportService('inactive', h, async () => undefined);
    const plan = await importer.preview('displayName,active\nЄвген,false\n');
    assert.deepEqual(plan.operations[0].changes, ['active']);
    await importer.commit(plan);
    assert.equal((await h.list()).length, 1);
    assert.equal((await h.findById('p'))?.isActive, false);
});

test('duplicate Telegram IDs and ambiguous database names block commit', async (t) => {
    const h = await repositoryHarness(t, 'conflict');
    await h.saveAll([player({ id: 'a', displayName: 'Олександр' }), player({ id: 'b', displayName: 'Олександр' })]);
    const importer = new PlayerImportService('conflict', h, async () => undefined);
    const fileDuplicate = await importer.preview('displayName,telegramUserId\nЄвген,123\nЖеня,123\n');
    assert.ok(fileDuplicate.conflicts.some((conflict) => conflict.type === 'csv_telegram_duplicate'));
    await assert.rejects(() => importer.commit(fileDuplicate), /IMPORT_PLAN_BLOCKED/);
    const ambiguous = await importer.preview('displayName\nОлександр\n');
    assert.equal(ambiguous.conflicts[0].type, 'ambiguous_exact_match');
});

test('failed backup and failed write leave the readable collection unchanged', async (t) => {
    const h = await repositoryHarness(t, 'failure');
    await h.save(player({ id: 'existing', displayName: 'Existing' }));
    const backupFailure = new PlayerImportService('failure', h, async () => { throw new Error('disk'); });
    const plan = await backupFailure.preview('displayName\nНовий\n');
    await assert.rejects(() => backupFailure.commit(plan), /резервну копію/);
    assert.deepEqual((await h.list()).map((item) => item.id), ['existing']);
    const original = h.saveAll.bind(h);
    h.saveAll = async () => { throw new Error('write'); };
    const writeFailure = new PlayerImportService('failure', h, async () => undefined);
    const writePlan = await writeFailure.preview('displayName\nНовий\n');
    await assert.rejects(() => writeFailure.commit(writePlan), /Попередні дані/);
    assert.deepEqual((await h.list()).map((item) => item.id), ['existing']);
    h.saveAll = original;
});

test('imports remain isolated between club repositories', async (t) => {
    const a = await repositoryHarness(t, 'club-a');
    const b = await repositoryHarness(t, 'club-b');
    await a.saveAll(Array.from({ length: 10 }, (_, index) => player({ id: `a${index}`, displayName: `A ${index}` })));
    await b.saveAll(Array.from({ length: 20 }, (_, index) => player({ id: `b${index}`, displayName: `B ${index}` })));
    const importer = new PlayerImportService('club-a', a, async () => undefined);
    const plan = await importer.preview('displayName\nNew One\nNew Two\nNew Three\nNew Four\nNew Five\n');
    await importer.commit(plan);
    assert.equal((await a.list()).length, 15);
    assert.equal((await b.list()).length, 20);
});

test('Telegram identity is confirmed and never auto-attaches to a same-name guest', async (t) => {
    const repository = await repositoryHarness(t, 'telegram');
    const service = new PlayerService({ players: repository } as unknown as RepositoriesContext);
    const guest = await service.resolveOrCreateTelegramGuest('Женя');
    const telegram = await service.findOrCreateByTelegramUser({ id: 123, first_name: 'Женя', username: 'zhenya' });
    assert.notEqual(guest.id, telegram.id);
    assert.equal(guest.isConfirmed, false);
    assert.equal(guest.source, 'telegram_guest');
    assert.equal(telegram.isConfirmed, true);
    assert.equal(telegram.source, 'telegram');
    assert.equal((await service.findOrCreateByTelegramUser({ id: 123, first_name: 'Женя 2' })).id, telegram.id);
    assert.equal((await repository.list()).length, 2);
});

test('manual merge migrates references and combines same-status places without losing snapshots', async (t) => {
    const repository = await repositoryHarness(t, 'merge');
    await repository.saveAll([player({ id: 'primary', displayName: 'Євген', telegramUserId: 123, isConfirmed: true }), player({ id: 'guest', displayName: 'Женя', aliases: ['Евгений'], source: 'telegram_guest' })]);
    let trainings = [trainingWithDuplicates()];
    const trainingRepository = {
        list: async () => structuredClone(trainings),
        saveAll: async (next: Training[]) => { trainings = structuredClone(next); },
    };
    const service = new PlayerService({ players: repository, trainings: trainingRepository } as unknown as RepositoriesContext);
    const merged = await service.merge('guest', 'primary');
    assert.deepEqual(merged.aliases.sort(), ['Евгений', 'Женя'].sort());
    assert.equal(trainings[0].participants.length, 1);
    assert.equal(trainings[0].participants[0].playerId, 'primary');
    assert.equal(trainings[0].participants[0].places, 3);
    assert.equal(trainings[0].participants[0].displayName, 'Євген snapshot');
    assert.equal((await repository.findById('guest'))?.isActive, false);
});

async function repositoryHarness(t: test.TestContext, name: string): Promise<PlayersRepository> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `players-${name}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repository = new PlayersRepository(path.join(root, 'players.json'));
    await repository.load();
    return repository;
}

function player(overrides: Partial<Player>): Player {
    return { id: 'p', displayName: 'Player', aliases: [], isConfirmed: false, isActive: true, source: 'admin', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}

function trainingWithDuplicates(): Training {
    return {
        id: 'training', clubId: 'club', chatId: -1, title: 'Historical', date: '2026-01-01', startTime: '10:00', endTime: '12:00',
        placesLimit: 12, minPlayers: 1, status: 'finished', waitlist: [], createdAt: '', updatedAt: '',
        participants: [
            { id: 'primary-entry', playerId: 'primary', displayName: 'Євген snapshot', places: 1, source: 'telegram_self', status: 'active', createdAt: '', updatedAt: '' },
            { id: 'guest-entry', playerId: 'guest', displayName: 'Женя snapshot', places: 2, source: 'telegram_guest', status: 'active', createdAt: '', updatedAt: '' },
        ],
    };
}
