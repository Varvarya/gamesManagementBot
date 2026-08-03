import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoriesContext } from '../../app/repositories.context';
import { PlayerService } from '../players/player.service';
import { RegistrationService } from './registration.service';
import { TrainingParticipantsService } from './training-participants.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';
import { backfillParticipantDisplayNames } from '../../app/repositories.context';

function training(overrides: Partial<Training> = {}): Training {
    return {
        id: 't1', clubId: 'club', chatId: -1, messageId: 10,
        title: 'Training', date: '2026-08-03', startTime: '19:00', endTime: '21:00',
        placesLimit: 2, minPlayers: 1, status: 'open', participants: [], waitlist: [],
        createdAt: '', updatedAt: '', ...overrides,
    };
}

function participantHarness(value = training()) {
    const service = {
        getRequired: async () => value,
        save: async (next: Training) => { value = next; return next; },
    } as unknown as TrainingService;
    return { participants: new TrainingParticipantsService(service), get: () => value };
}

test('fills main list, then waitlist, and rejects duplicates', async () => {
    const h = participantHarness();
    const add = (playerId: string) => h.participants.addParticipant({ trainingId: 't1', playerId, displayName: playerId, places: 1, source: 'telegram' });
    assert.equal((await add('p1')).outcome, 'registered');
    assert.equal((await add('p2')).outcome, 'registered');
    assert.equal((await add('p3')).outcome, 'waitlisted');
    await assert.rejects(() => add('p1'), /already registered/);
    assert.deepEqual(h.get().participants.map((x) => x.playerId), ['p1', 'p2']);
    assert.deepEqual(h.get().waitlist.map((x) => x.playerId), ['p3']);
});

test('cancellation promotes the first waitlisted player and preserves order', async () => {
    const h = participantHarness(training({ placesLimit: 1 }));
    for (const id of ['p1', 'p2', 'p3']) await h.participants.addParticipant({ trainingId: 't1', playerId: id, displayName: id, places: 1, source: 'telegram' });
    const result = await h.participants.removeParticipant({ trainingId: 't1', playerId: 'p1' });
    assert.deepEqual(result.promotedPlayerIds, ['p2']);
    assert.deepEqual(h.get().participants.map((x) => x.playerId), ['p2']);
    assert.deepEqual(h.get().waitlist.map((x) => x.playerId), ['p3']);
});

test('simultaneous registrations are serialized around the last main place', async () => {
    const h = participantHarness(training({ placesLimit: 1 }));
    await Promise.all(['p1', 'p2'].map((playerId) => h.participants.addParticipant({ trainingId: 't1', playerId, displayName: playerId, places: 1, source: 'telegram' })));
    assert.equal(h.get().participants.length, 1);
    assert.equal(h.get().waitlist.length, 1);
});

test('closed training rejects participant changes', async () => {
    const h = participantHarness(training({ status: 'closed' }));
    await assert.rejects(() => h.participants.addParticipant({ trainingId: 't1', playerId: 'p1', displayName: 'P1', places: 1, source: 'telegram' }), /not open/);
});

test('archived training remains read-only even for admin override', async () => {
    const h = participantHarness(training({ status: 'archived' }));
    await assert.rejects(() => h.participants.addParticipant({ trainingId: 't1', playerId: 'p1', displayName: 'P1', places: 1, source: 'admin', overrideState: true }), /read-only/);
    await assert.rejects(() => h.participants.removeParticipant({ trainingId: 't1', playerId: 'p1', overrideState: true }), /read-only/);
});

test('unsupported +2 is rejected by participant boundary', async () => {
    const h = participantHarness();
    await assert.rejects(() => h.participants.addParticipant({ trainingId: 't1', playerId: 'p1', displayName: 'P1', places: 2, source: 'telegram' }), /Only \+1/);
});

test('training resolution prefers reply and requires a selector for two open trainings', async () => {
    const first = training();
    const second = training({ id: 't2', messageId: 20, startTime: '20:00' });
    const repository = {
        findByMessageId: async (_chatId: number, messageId: number) => [first, second].find((x) => x.messageId === messageId),
        listOpenByChatId: async () => [first, second],
    };
    const service = new TrainingService({ trainings: repository } as unknown as RepositoriesContext);
    assert.equal((await service.resolveTargetTraining({ chatId: -1, replyToMessageId: 20 }))?.id, 't2');
    assert.equal(await service.resolveTargetTraining({ chatId: -1 }), undefined);
    assert.equal((await service.resolveTargetTraining({ chatId: -1, startTime: '19:00' }))?.id, 't1');
});

test('+1 named guest creates a separate unconfirmed player and registers it', async () => {
    const stored: any[] = [];
    const repositories = {
        players: {
            list: async () => stored,
            save: async (player: any) => { const i = stored.findIndex((x) => x.id === player.id); i < 0 ? stored.push(player) : stored.splice(i, 1, player); return player; },
            findByTelegramId: async (id: number) => stored.find((x) => x.telegramUserId === id),
        },
    } as unknown as RepositoriesContext;
    const h = participantHarness();
    const registration = new RegistrationService(
        new PlayerService(repositories),
        { resolveTargetTraining: async () => h.get() } as unknown as TrainingService,
        h.participants,
    );
    await registration.registerDetailed({ telegramUser: { id: 7, first_name: 'Owner' }, chatId: -1, places: 1, playerName: 'Guest Name' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].displayName, 'Guest Name');
    assert.equal(stored[0].isConfirmed, false);
    assert.equal(stored[0].telegramUserId, undefined);
    assert.equal(h.get().participants[0].displayName, 'Guest Name');
});

test('legacy participant migration resolves player names and uses a safe fallback', () => {
    const value = training({
        participants: [
            { id: 'e1', playerId: 'p1', places: 1, source: 'telegram', status: 'active', createdAt: '', updatedAt: '' },
            { id: 'e2', playerId: 'missing', places: 1, source: 'telegram', status: 'active', createdAt: '', updatedAt: '' },
        ] as any,
    });
    const migrated = backfillParticipantDisplayNames([value], [{ id: 'p1', displayName: 'Олена', aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' }]);
    assert.equal(migrated, 2);
    assert.deepEqual(value.participants.map((entry) => entry.displayName), ['Олена', 'Гравець']);
    assert.equal(backfillParticipantDisplayNames([value], []), 0);
});
