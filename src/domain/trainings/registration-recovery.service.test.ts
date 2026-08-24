import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ServicesContext } from '../../app/services.context';
import { JsonStorage } from '../../storage/jsonStorage';
import { TelegramHistoryMessage } from '../telegram-import/telegram-user-connection.manager';
import { ProcessedRegistrationMessageStore } from './processed-registration-message.store';
import { RegistrationRecoveryService } from './registration-recovery.service';
import { TrainingPublisherService } from './training-publisher.service';
import { Training } from './training.types';

function initial(): Training {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return { id: 'training', clubId: 'club', chatId: -100, messageId: 42, title: 'Training', date: today, startTime: '17:30', endTime: '19:30', placesLimit: 4, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '2026-08-19T11:00:00.000Z', publishedAt: '2026-08-19T12:00:00.000Z', registrationOpenedAt: '2026-08-19T12:00:00.000Z', updatedAt: '' };
}
function msg(messageId: number, text: string, minute: number, user = 7): TelegramHistoryMessage {
    return { messageId, text, date: new Date(`2026-08-19T13:${String(minute).padStart(2, '0')}:00Z`), telegramUser: { id: user, first_name: user === 7 ? 'Volodymyr' : `User ${user}` } };
}

async function harness(messages: TelegramHistoryMessage[], complete = true, seed = initial()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reconcile-'));
    let value = structuredClone(seed); let refreshes = 0; let saves = 0; let newPosts = 0;
    const players = new Map<number, { id: string; displayName: string; telegramUserId: number }>();
    const playerService = {
        findOrCreateByTelegramUser: async (u: { id: number; first_name?: string }) => { const p = players.get(u.id) ?? { id: `p${u.id}`, displayName: u.first_name ?? String(u.id), telegramUserId: u.id }; players.set(u.id, p); return p; },
        findByTelegramId: async (id: number) => players.get(id),
        resolveOrCreateTelegramGuest: async (name: string) => ({ id: `guest:${name}`, displayName: name, aliases: [], isConfirmed: false, isActive: true, createdAt: '', updatedAt: '' }),
        resolveByStrongName: async () => undefined,
    };
    const services = {
        players: playerService,
        trainings: {
            getRequired: async () => structuredClone(value),
            listRelevantOpenByChatId: async () => [structuredClone(value)],
            isRelevantOpen: (training: Training, chatId: number) => training.status === 'open' && training.chatId === chatId && training.messageId !== undefined,
        },
        repositories: {
            clubId: 'club',
            trainings: { list: async () => [structuredClone(value)], save: async (next: Training) => { saves++; value = structuredClone(next); return next; } },
            settings: { get: async () => ({ timezone: 'Europe/Kyiv', admins: [] }) },
        },
    } as unknown as ServicesContext;
    const history = { readRecentMessages: async () => ({ messages, complete }) };
    const publisher = {
        refreshMessage: async () => { refreshes++; },
        publish: async () => { newPosts++; throw new Error('Reconciliation must not publish a new message'); },
    } as unknown as TrainingPublisherService;
    const store = new ProcessedRegistrationMessageStore(new JsonStorage({ dataDir: root, storageSlug: 'club' }));
    const recovery = new RegistrationRecoveryService('club', services, publisher, history as never, store);
    return { recovery, get training() { return value; }, get refreshes() { return refreshes; }, get saves() { return saves; }, get newPosts() { return newPosts; } };
}

test('restart rebuild applies missed conversational -1 chronologically', async () => {
    const stale = initial();
    stale.participants.push({ id: 'stale', playerId: 'p7', telegramUserId: 7, registeredByTelegramUserId: 7, displayName: 'Volodymyr', places: 1, source: 'telegram_self', status: 'active', createdAt: '', updatedAt: '' });
    const h = await harness([msg(43, '+1', 11), msg(44, 'Перепрошую, сьогодні не зможу. -1', 13)], true, stale);
    const result = await h.recovery.recoverTraining(h.training);
    assert.equal(result.commandsApplied, 2);
    assert.equal(result.newActivePlaces, 0);
    assert.equal(h.training.participants.length, 0);
    assert.equal(result.stateChanged, true);
    assert.equal(h.refreshes, 1);
});

test('repeated reconciliation is deterministic and does not duplicate +N', async () => {
    const h = await harness([msg(43, '+2', 1), msg(44, '+1', 2, 8)]);
    await h.recovery.recoverTraining(h.training);
    assert.equal(h.training.participants.reduce((n, p) => n + p.places, 0), 3);
    const saves = h.saves; const refreshes = h.refreshes;
    const second = await h.recovery.recoverTraining(h.training);
    assert.equal(second.stateChanged, false);
    assert.equal(h.saves, saves);
    assert.equal(h.refreshes, refreshes);
});

test('waitlist is rebuilt through normal capacity logic', async () => {
    const h = await harness([msg(43, '+4', 1), msg(44, '+2', 2, 8), msg(45, '-1', 3)]);
    const result = await h.recovery.recoverTraining(h.training);
    assert.equal(result.newActivePlaces, 3);
    assert.equal(result.newWaitingPlaces, 2);
});

test('partial history never overwrites persisted registration state', async () => {
    const seed = initial();
    seed.participants.push({ id: 'manual', playerId: 'm', displayName: 'Manual', places: 1, source: 'admin', status: 'active', createdAt: '', updatedAt: '' });
    const h = await harness([msg(43, '+4', 1)], false, seed);
    const result = await h.recovery.recoverTraining(h.training);
    assert.equal(result.stateChanged, false);
    assert.equal(h.saves, 0);
    assert.equal(h.training.participants[0].source, 'admin');
});

test('messages at or before bot publication message are never replayed', async () => {
    const h = await harness([msg(40, '+4', 1), msg(42, '+4', 2), msg(43, '+1', 3)]);
    const result = await h.recovery.recoverTraining(h.training);
    assert.equal(result.newActivePlaces, 1);
});

test('startup reconciliation removes historical places with a mismatched explicit time and is idempotent', async () => {
    const stale = initial();
    stale.startTime = '18:00';
    stale.endTime = '20:00';
    stale.placesLimit = 10;
    stale.participants.push({ id: 'stale', playerId: 'p8', telegramUserId: 8, registeredByTelegramUserId: 8, displayName: 'User 8', places: 4, source: 'telegram_self', status: 'active', createdAt: '', updatedAt: '' });
    const h = await harness([msg(43, '+1', 1), msg(44, '+4 17:30', 2, 8), msg(45, '+1 18:00', 3, 9)], true, stale);

    const records: Array<Record<string, unknown>> = [];
    const originalInfo = console.info;
    console.info = (line?: unknown) => {
        if (typeof line === 'string') {
            try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a structured application log */ }
        }
    };
    try { await h.recovery.recoverActive(); } finally { console.info = originalInfo; }

    assert.equal(h.training.participants.reduce((sum, entry) => sum + entry.places, 0), 2);
    assert.equal(h.training.waitlist.length, 0);
    assert.equal(h.training.participants.some((entry) => entry.telegramUserId === 8), false);
    assert.equal(h.refreshes, 1, 'the existing canonical message is edited once');
    assert.equal(h.newPosts, 0, 'reconciliation never publishes a replacement post');
    assert.ok(records.some((entry) => entry.event === 'registration.command_rejected' && entry.reason === 'explicit_time_mismatch'));
    assert.equal(records.some((entry) => entry.event === 'registration.added' && entry.telegramUserId === 8), false);

    const saves = h.saves;
    await h.recovery.recoverActive();
    assert.equal(h.saves, saves);
    assert.equal(h.refreshes, 1);
    assert.equal(h.newPosts, 0);
});

test('replay counts commands without a time or with the exact start and ignores mismatches completely', async () => {
    const seed = initial();
    seed.startTime = '18:00';
    seed.endTime = '20:00';
    seed.placesLimit = 10;
    const h = await harness([
        msg(43, '+4', 1, 7),
        msg(44, '+4 18:00', 2, 8),
        msg(45, '+4 17:30', 3, 9),
        msg(46, '+1 18:30', 4, 10),
    ], true, seed);

    const result = await h.recovery.recoverTraining(h.training);

    assert.equal(result.commandsParsed, 4);
    assert.equal(result.commandsApplied, 2);
    assert.equal(result.newActivePlaces, 8);
    assert.equal(result.newWaitingPlaces, 0);
    assert.deepEqual(h.training.participants.map((entry) => entry.telegramUserId), [7, 8]);
    assert.equal(h.refreshes, 1);
    assert.equal(h.newPosts, 0);
});
