import assert from 'node:assert/strict';
import test from 'node:test';
import { Telegram } from 'telegraf';

import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingMessageRenderer } from './training-message.renderer';
import { TrainingPublisherService } from './training-publisher.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';

test('manual publication is explicitly logged as manual_admin', async () => {
    const records: Array<Record<string, unknown>> = [];
    const originalInfo = console.info;
    console.info = (line?: unknown) => { if (typeof line === 'string') records.push(JSON.parse(line)); };
    try {
        let training = { id: 'manual-training', clubId: 'club', chatId: -200, title: 'Manual', date: '2026-08-24', startTime: '18:00', endTime: '20:00', placesLimit: 8, minPlayers: 2, status: 'draft', participants: [], waitlist: [], createdAt: '', updatedAt: '' } as Training;
        const publisher = new TrainingPublisherService(
            { sendMessage: async () => ({ message_id: 77 }) } as unknown as Telegram,
            { players: { list: async () => [] } } as unknown as RepositoriesContext,
            { createDraft: async () => training, publish: async ({ messageId }: { messageId: number }) => (training = { ...training, status: 'open', messageId }) } as unknown as TrainingService,
            { render: () => 'manual' } as unknown as TrainingMessageRenderer,
        );
        await publisher.publishManual({ clubId: 'club', chatId: -200, title: 'Manual', date: '2026-08-24', startTime: '18:00', endTime: '20:00', placesLimit: 8, minPlayers: 2 });
    } finally { console.info = originalInfo; }
    const sent = records.find((record) => record.event === 'training_publication.telegram_send_started');
    assert.equal(sent?.triggerSource, 'manual_admin');
});

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

test('manual and scheduled publication of the same draft send exactly one Telegram message', async () => {
    let sends = 0;
    let stored = { id: 'training', clubId: 'club', chatId: -100, title: 'Training', date: '2026-08-20', startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 4, status: 'draft', participants: [], waitlist: [], createdAt: '', updatedAt: '' } as Training;
    const publisher = new TrainingPublisherService(
        { sendMessage: async () => { sends++; await Promise.resolve(); return { message_id: 42 }; } } as unknown as Telegram,
        { players: { list: async () => [] }, trainings: { save: async (value: Training) => value } } as unknown as RepositoriesContext,
        { getRequired: async () => stored, publish: async ({ messageId }: { messageId: number }) => (stored = { ...stored, status: 'open', messageId, publishedAt: 'now' }) } as unknown as TrainingService,
        { render: () => 'training' } as unknown as TrainingMessageRenderer,
    );
    const [manual, scheduled] = await Promise.all([publisher.publishExistingDraft('training'), publisher.publishExistingDraft('training')]);
    assert.equal(sends, 1);
    assert.equal(manual.messageId, scheduled.messageId);
});

test('a persisted draft from a failed send is reused and published on retry', async () => {
    let sends = 0;
    let stored = {
        id: 'training', clubId: 'club', templateId: 'template', templateSlotId: 'slot', chatId: -1001,
        title: 'Training', date: '2026-08-03', startTime: '19:00', endTime: '21:00', placesLimit: 20,
        minPlayers: 8, status: 'draft', participants: [], waitlist: [], createdAt: '', updatedAt: '',
    } as Training;
    const publisher = new TrainingPublisherService(
        { sendMessage: async () => ({ message_id: ++sends }) } as unknown as Telegram,
        { trainings: { findByTemplateSlotAndDate: async () => stored }, players: { list: async () => [] } } as unknown as RepositoriesContext,
        {
            publish: async ({ messageId }: { messageId: number }) => {
                stored = { ...stored, messageId, status: 'open', publishedAt: 'now' };
                return stored;
            },
        } as unknown as TrainingService,
        { render: () => 'training' } as unknown as TrainingMessageRenderer,
    );

    const result = await publisher.publishTemplateSlot({
        templateId: 'template', slotId: 'slot', clubId: 'club', chatId: -1001, title: 'Training',
        date: '2026-08-03', startTime: '19:00', endTime: '21:00', placesLimit: 20, minPlayers: 8,
    });

    assert.equal(sends, 1);
    assert.equal(result.status, 'open');
    assert.equal(result.messageId, 1);
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
        { players: { list: async () => [] }, trainings: { save: async (value: Training) => value } } as unknown as RepositoriesContext,
        { getRequired: async () => training } as unknown as TrainingService,
        { render: () => 'updated message' } as unknown as TrainingMessageRenderer,
    );

    assert.equal(await publisher.refreshMessage(training.id), false);
    assert.equal(await publisher.refreshMessage(training.id), true);
    assert.equal(attempts, 2);
});

test('restart refresh edits the persisted canonical chat/message and never publishes a replacement', async () => {
    const training = {
        id: 'training', clubId: 'club', chatId: -100777, messageId: 918,
        title: 'Training', date: '2026-08-21', startTime: '18:00', endTime: '20:00',
        placesLimit: 8, minPlayers: 2, status: 'open', participants: [], waitlist: [],
        createdAt: '', publishedAt: '2026-08-20T15:10:00.000Z', updatedAt: '',
    } as Training;
    const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
    let sends = 0;
    // A newly constructed publisher models process restart: there is no
    // in-memory publication/message reference to rely on.
    const publisher = new TrainingPublisherService(
        {
            editMessageText: async (chatId: number, messageId: number, _inline: undefined, text: string) => { edits.push({ chatId, messageId, text }); return true; },
            sendMessage: async () => { sends++; throw new Error('must not publish during refresh'); },
        } as unknown as Telegram,
        { players: { list: async () => [] } } as unknown as RepositoriesContext,
        { getRequired: async () => training } as unknown as TrainingService,
        { render: () => 'canonical corrected list' } as unknown as TrainingMessageRenderer,
    );

    assert.equal(await publisher.refreshMessage(training.id), true);
    assert.deepEqual(edits, [{ chatId: -100777, messageId: 918, text: 'canonical corrected list' }]);
    assert.equal(sends, 0);
});

test('missing persisted message identity never falls back to sending a duplicate', async () => {
    const training = {
        id: 'training', clubId: 'club', chatId: -100777, title: 'Training', date: '2026-08-21',
        startTime: '18:00', endTime: '20:00', placesLimit: 8, minPlayers: 2, status: 'open',
        participants: [], waitlist: [], createdAt: '', updatedAt: '',
    } as Training;
    let edits = 0; let sends = 0;
    const publisher = new TrainingPublisherService(
        { editMessageText: async () => { edits++; }, sendMessage: async () => { sends++; } } as unknown as Telegram,
        { players: { list: async () => [] } } as unknown as RepositoriesContext,
        { getRequired: async () => training } as unknown as TrainingService,
        { render: () => 'unused' } as unknown as TrainingMessageRenderer,
    );
    assert.equal(await publisher.refreshMessage(training.id), false);
    assert.equal(edits, 0);
    assert.equal(sends, 0);
});
