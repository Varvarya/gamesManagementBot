import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoriesContext } from '../../app/repositories.context';
import { Training } from '../trainings/training.types';
import { PlayerService } from './player.service';
import { Player } from './player.types';

function player(id: string, name: string, overrides: Partial<Player> = {}): Player {
    return { id, displayName: name, aliases: [], isConfirmed: false, isActive: true, createdAt: '', updatedAt: '', ...overrides };
}

function harness(initial: Player[] = [], trainings: Training[] = []) {
    const players = [...initial];
    const repositories = {
        players: {
            list: async () => players,
            findById: async (id: string) => players.find((item) => item.id === id),
            findByTelegramId: async (id: number) => players.find((item) => item.telegramUserId === id),
            searchByName: async (query: string) => players.filter((item) => [item.displayName, item.telegramName, item.username, ...item.aliases].some((value) => value?.toLowerCase().includes(query.toLowerCase()))),
            save: async (value: Player) => { const index = players.findIndex((item) => item.id === value.id); index < 0 ? players.push(value) : players.splice(index, 1, value); return value; },
            delete: async (id: string) => { const index = players.findIndex((item) => item.id === id); if (index >= 0) players.splice(index, 1); },
        },
        trainings: {
            list: async () => trainings,
            save: async (value: Training) => value,
        },
    } as unknown as RepositoriesContext;
    return { service: new PlayerService(repositories), players, trainings };
}

test('player search covers names, username and aliases with relevant result order', async () => {
    const h = harness([
        player('1', 'Oleksandr', { username: 'alex' }),
        player('2', 'Alex', { isConfirmed: true }),
        player('3', 'Sasha', { aliases: ['Alex guest'] }),
    ]);
    assert.deepEqual((await h.service.search('alex')).map((item) => item.id), ['2', '1', '3']);
});

test('player search tolerates typos in display names, usernames and aliases', async () => {
    const h = harness([
        player('1', 'Oleksandr'),
        player('2', 'Maria', { username: 'maria_play' }),
        player('3', 'Oksana', { aliases: ['Sashko'] }),
    ]);

    assert.deepEqual((await h.service.search('Oleksadr')).map((item) => item.id), ['1']);
    assert.deepEqual((await h.service.search('@maria_paly')).map((item) => item.id), ['2']);
    assert.deepEqual((await h.service.search('Sashkoo')).map((item) => item.id), ['3']);
});

test('player search sorts strongest matches first and never returns more than ten', async () => {
    const matchingPlayers = Array.from({ length: 12 }, (_, index) =>
        player(`prefix-${index}`, `Anna player ${index}`),
    );
    const h = harness([
        player('fuzzy', 'Ana'),
        ...matchingPlayers,
        player('exact', 'Anna'),
    ]);

    const results = await h.service.search('Anna', 50);
    assert.equal(results.length, 10);
    assert.equal(results[0].id, 'exact');
    assert.ok(results.every((item) => item.id !== 'fuzzy'));
});

test('player search is transliteration-friendly and filters inactive partial matches', async () => {
    const h = harness([
        player('active', 'Варвара Тишеніна'),
        player('inactive', 'Варвара Стара', { isActive: false }),
    ]);
    assert.deepEqual((await h.service.search('Varvara')).map((item) => item.id), ['active']);
    assert.deepEqual((await h.service.search('Варвара Стара')).map((item) => item.id), ['inactive']);
    assert.deepEqual((await h.service.search('Varvara', 10, { includeInactive: true })).map((item) => item.id), ['active', 'inactive']);
});

test('manual creation returns a confirmed player and confirmation remains idempotent', async () => {
    const h = harness();
    const created = await h.service.createManual('New Player');
    assert.equal(created.displayName, 'New Player');
    assert.equal(created.isConfirmed, true);
    assert.equal((await h.service.confirm(created.id)).isConfirmed, true);
});

test('manual creation prevents duplicates across aliases', async () => {
    const h = harness([player('1', 'Primary', { aliases: ['Duplicate'] })]);
    await assert.rejects(() => h.service.createManual('duplicate'), /already exists/);
});

test('manual creation can proceed after an explicit duplicate override', async () => {
    const h = harness([player('1', 'Primary', { aliases: ['Duplicate'] })]);
    const created = await h.service.createManual('Duplicate', true);
    assert.equal(created.displayName, 'Duplicate');
    assert.equal(h.players.length, 2);
});

test('confirmation, activation and alias mutations return the updated player', async () => {
    const h = harness([player('1', 'Varvara')]);

    assert.equal((await h.service.setConfirmed('1', true)).isConfirmed, true);
    assert.equal((await h.service.setActive('1', false)).isActive, false);
    assert.equal((await h.service.setActive('1', true)).isActive, true);
    assert.deepEqual((await h.service.addAlias('1', 'Varia')).aliases, ['Varia']);
    assert.deepEqual((await h.service.addAlias('1', 'Varia')).aliases, ['Varia']);
});

test('mistaken pending player can be deleted only when it has no registrations', async () => {
    const pending = player('pending', 'Mistake');
    const confirmed = player('confirmed', 'Known', { isConfirmed: true });
    const h = harness([pending, confirmed]);
    await h.service.deleteMistakenPlayer('pending');
    assert.equal(h.players.some((item) => item.id === 'pending'), false);
    await assert.rejects(() => h.service.deleteMistakenPlayer('confirmed'), /не можна видалити/);
});

test('merge migrates main and waitlist registrations once and deactivates source', async () => {
    const source = player('source', 'Old Name', { telegramUserId: 7, aliases: ['Old'] });
    const target = player('target', 'Real Name', { isConfirmed: true });
    const base = { clubId: 'c', chatId: -1, title: 'T', date: '2026-09-01', startTime: '10:00', endTime: '11:00', placesLimit: 2, minPlayers: 1, status: 'open', createdAt: '', updatedAt: '' } as const;
    const trainings: Training[] = [{ ...base, id: 't1', participants: [{ id: 'e1', playerId: 'source', displayName: 'Old Name', places: 1, source: 'admin', status: 'active', createdAt: '', updatedAt: '' }], waitlist: [] }, { ...base, id: 't2', participants: [], waitlist: [{ id: 'e2', playerId: 'source', displayName: 'Old Name', places: 1, source: 'admin', status: 'waiting', createdAt: '', updatedAt: '' }, { id: 'e3', playerId: 'target', displayName: 'Real Name', places: 1, source: 'admin', status: 'waiting', createdAt: '', updatedAt: '' }] }];
    const h = harness([source, target], trainings);
    const merged = await h.service.merge('source', 'target');
    assert.equal(merged.telegramUserId, 7);
    assert.ok(merged.aliases.includes('Old Name'));
    assert.equal(trainings[0].participants[0].playerId, 'target');
    assert.equal(trainings[0].participants[0].displayName, 'Old Name');
    assert.equal(trainings[1].waitlist.filter((entry) => entry.playerId === 'target').length, 1);
    assert.equal(source.isActive, false);
});
