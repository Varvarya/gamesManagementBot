import assert from 'node:assert/strict';
import test from 'node:test';
import { Telegram } from 'telegraf';

import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingMessageRenderer } from './training-message.renderer';
import { TrainingPublisherService } from './training-publisher.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';

test('concurrent template publication is deduplicated', async () => {
    let stored: Training | undefined;
    let sends = 0;
    const repositories = {
        trainings: {
            findByTemplateSlotAndDate: async () => stored,
        },
        players: { list: async () => [] },
    } as unknown as RepositoriesContext;
    const trainings = {
        createDraft: async (input: Partial<Training>) => {
            stored = {
                ...input,
                id: 'training',
                status: 'draft',
                participants: [],
                waitlist: [],
                createdAt: '',
                updatedAt: '',
            } as Training;
            return stored;
        },
        publish: async ({ messageId }: { messageId: number }) => {
            stored = { ...stored!, messageId, status: 'open' };
            return stored;
        },
    } as unknown as TrainingService;
    const telegram = {
        sendMessage: async () => {
            sends += 1;
            await Promise.resolve();
            return { message_id: 42 };
        },
        deleteMessage: async () => true,
    } as unknown as Telegram;
    const renderer = {
        render: () => 'training',
    } as unknown as TrainingMessageRenderer;
    const publisher = new TrainingPublisherService(
        telegram,
        repositories,
        trainings,
        renderer,
    );
    const input = {
        templateId: 'template',
        slotId: 'slot',
        clubId: 'club',
        chatId: -1001,
        title: 'Training',
        date: '2026-08-03',
        startTime: '19:00',
        endTime: '21:00',
        placesLimit: 20,
        minPlayers: 8,
    };
    const [first, second] = await Promise.all([
        publisher.publishTemplateSlot(input),
        publisher.publishTemplateSlot(input),
    ]);
    assert.equal(sends, 1);
    assert.equal(first.id, second.id);
    assert.equal(first.status, 'open');
});

test('message refresh skips unchanged content and coalesces concurrent requests', async () => {
    let version = 1;
    let edits = 0;
    const training = {
        id: 'training', clubId: 'club', chatId: -1001, messageId: 42,
        title: 'Training', date: '2026-08-03', startTime: '19:00', endTime: '21:00',
        placesLimit: 10, minPlayers: 2, status: 'open', participants: [], waitlist: [],
        createdAt: '', updatedAt: '',
    } as Training;
    const publisher = new TrainingPublisherService(
        { editMessageText: async () => { edits += 1; await Promise.resolve(); return true; } } as unknown as Telegram,
        { players: { list: async () => [] } } as unknown as RepositoriesContext,
        { getRequired: async () => training } as unknown as TrainingService,
        { render: () => `version:${version}` } as unknown as TrainingMessageRenderer,
    );

    const results = await Promise.all([
        publisher.refreshMessage(training.id),
        publisher.refreshMessage(training.id),
    ]);
    assert.equal(edits, 1);
    assert.deepEqual(results, [true, true]);
    assert.equal(await publisher.refreshMessage(training.id), false);
    assert.equal(edits, 1);

    version = 2;
    assert.equal(await publisher.refreshMessage(training.id), true);
    assert.equal(edits, 2);
});

test('Telegram edit failure is contained and a later refresh can retry', async () => {
    let attempts = 0;
    const training = {
        id: 'training', clubId: 'club', chatId: -1001, messageId: 42,
        title: 'Training', date: '2026-08-03', startTime: '19:00', endTime: '21:00',
        placesLimit: 10, minPlayers: 2, status: 'open', participants: [], waitlist: [],
        createdAt: '', updatedAt: '',
    } as Training;
    const publisher = new TrainingPublisherService(
        { editMessageText: async () => { attempts += 1; if (attempts === 1) throw new Error('message to edit not found'); return true; } } as unknown as Telegram,
        { players: { list: async () => [] } } as unknown as RepositoriesContext,
        { getRequired: async () => training } as unknown as TrainingService,
        { render: () => 'updated message' } as unknown as TrainingMessageRenderer,
    );

    assert.equal(await publisher.refreshMessage(training.id), false);
    assert.equal(await publisher.refreshMessage(training.id), true);
    assert.equal(attempts, 2);
});
