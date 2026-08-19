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

function training(): Training {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return { id: 'training', clubId: 'club', chatId: -100, messageId: 42, title: 'Training', date: today, startTime: '17:30', endTime: '19:30', placesLimit: 20, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '2026-08-19T11:00:00.000Z', publishedAt: '2026-08-19T12:00:00.000Z', updatedAt: '' };
}

function message(messageId: number, text: string, minute: number): TelegramHistoryMessage {
    return { messageId, text, date: new Date(`2026-08-19T13:${String(minute).padStart(2, '0')}:00.000Z`), telegramUser: { id: 7, first_name: 'User' } };
}

async function harness(messages: TelegramHistoryMessage[], directory?: string) {
    const root = directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'registration-recovery-'));
    const value = training(); let places = 0; let openedAt: Date | undefined; let refreshes = 0;
    const registration = {
        resolveCommand: async (input: { command: { trainingHint?: { time?: string } } }) => input.command.trainingHint?.time && input.command.trainingHint.time !== value.startTime ? { kind: 'none', reason: 'NO_OPEN_TRAINING' } : { kind: 'ready', training: value },
        executeCommandAgainstTraining: async (input: { command: { operation: 'add' | 'remove'; count: number } }) => { places = input.command.operation === 'add' ? places + input.command.count : Math.max(0, places - input.command.count); return []; },
    };
    const services = { repositories: { trainings: { list: async () => [value] } }, registration } as unknown as ServicesContext;
    const publisher = { refreshMessage: async () => { refreshes++; } } as unknown as TrainingPublisherService;
    const history = { readRecentMessages: async (_clubId: string, _chatId: number, since: Date) => { openedAt = since; return messages; } };
    const store = new ProcessedRegistrationMessageStore(new JsonStorage({ dataDir: root, storageSlug: 'club' }));
    const recovery = new RegistrationRecoveryService('club', services, publisher, history as never, store);
    return { root, recovery, store, get places() { return places; }, get openedAt() { return openedAt; }, get refreshes() { return refreshes; } };
}

test('real missed messy message is applied once and remains processed after store restart', async () => {
    const missed = message(101, 'сегодня 17-30, +4  )))', 15);
    const first = await harness([missed]);
    await first.recovery.recoverActive();
    assert.equal(first.places, 4);
    assert.equal(first.openedAt?.toISOString(), '2026-08-19T12:00:00.000Z');
    assert.equal(await first.store.has(-100, 101), true);

    const second = await harness([missed], first.root);
    await second.recovery.recoverActive();
    assert.equal(second.places, 0, 'persisted marker prevents replay after restart');
    assert.equal(second.refreshes, 0);
});

test('recovery replays oldest to newest and ignores mixed unrelated chat', async () => {
    const ordered = await harness([message(4, '-2', 15), message(2, '+1', 5), message(1, '+1', 0), message(3, '+1', 10)]);
    await ordered.recovery.recoverActive();
    assert.equal(ordered.places, 1);

    const mixed = await harness([message(10, 'дякую', 0), message(11, 'сегодня 17-30, +4  )))', 5), message(12, 'хто сьогодні буде?', 10), message(13, '-1', 15), message(14, '😂', 20)]);
    await mixed.recovery.recoverActive();
    assert.equal(mixed.places, 3);
});

test('concurrent live/recovery claims execute a message only once', async () => {
    const h = await harness([]); let calls = 0;
    const action = async () => { calls++; await Promise.resolve(); return { value: true, trainingId: 'training' }; };
    const results = await Promise.all([h.store.processOnce(-100, 500, action), h.store.processOnce(-100, 500, action)]);
    assert.equal(calls, 1);
    assert.equal(results.filter((item) => item.duplicate).length, 1);
});
