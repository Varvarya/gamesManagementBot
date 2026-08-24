import assert from 'node:assert/strict';
import test from 'node:test';
import { Training, ParticipantEntry } from '../../domain/trainings/training.types';
import { AdminTrainingHandler } from './handlers/admin-training.handler';
import { TrainingFlowHandler } from './flows/training-flow.handler';
import { findCallbackHandler } from './admin-callback-router';
import { AdminCallbacks } from './callbacks/admin-callbacks';
import {
    createActiveTrainingsKeyboard,
    createArchivedTrainingKeyboard,
    createArchivedTrainingsKeyboard,
    createTrainingCancelKeyboard,
    createTrainingKeyboard,
    createTrainingParticipantsKeyboard,
    createTrainingPlayerSearchKeyboard,
    createTrainingReconcileConfirmKeyboard,
    createUnknownTrainingPlayerKeyboard,
    createNewTrainingPlayerPreviewKeyboard,
    createTrainingPlayerDuplicateKeyboard,
} from './keyboards/training.keyboard';
import { isTrainingParticipantListTruncated, renderTrainingCard } from './ui/admin-formatters';

function entry(index: number, status: ParticipantEntry['status'] = 'active'): ParticipantEntry {
    return { id: `e${index}`, playerId: `p${index}`, displayName: `Snapshot ${index}`, places: 1, source: 'admin', status, createdAt: '', updatedAt: '' };
}
function training(status: Training['status'] = 'open', participants = 0, waiting = 0): Training {
    return { id: 'training_123', clubId: 'club', chatId: -1001, title: 'Ранкові тренування', date: '2026-08-04', startTime: '08:30', endTime: '10:30', placesLimit: 12, minPlayers: 4, status, participants: Array.from({ length: participants }, (_, i) => entry(i + 1)), waitlist: Array.from({ length: waiting }, (_, i) => entry(participants + i + 1, 'waiting')), createdAt: '', updatedAt: '' };
}
const names = (count: number) => new Map(Array.from({ length: count }, (_, i) => [`p${i + 1}`, `Гравець ${i + 1}`]));
const labels = (keyboard: ReturnType<typeof createTrainingKeyboard>) => keyboard.reply_markup.inline_keyboard.flat().map((button) => 'text' in button ? button.text : '');
const callbacks = (keyboard: { reply_markup: { inline_keyboard: readonly (readonly object[])[] } }) => keyboard.reply_markup.inline_keyboard.flat().flatMap((button) => 'callback_data' in button ? [String(button.callback_data)] : []);

test('training card renders the compact empty state', () => {
    const text = renderTrainingCard(training(), { playerNames: names(0), chatName: 'Sunrise' });
    assert.match(text, /🟢 Запис відкрито\n0\/12/);
    assert.doesNotMatch(text, /-1001/);
});
test('participant and waitlist order and names are shown directly', () => {
    const text = renderTrainingCard(training('open', 3, 2), { playerNames: names(5), chatName: 'Sunrise' });
    assert.match(text, /1\. Гравець 1\n2\. Гравець 2\n3\. Гравець 3/);
    assert.match(text, /⏳ Очікують\n1\. Гравець 4\n2\. Гравець 5/);
});

test('admin training card counts and labels reserved places', () => {
    const value = training('open', 2, 0);
    value.participants[0].places = 2;
    value.participants[1].places = 4;
    const text = renderTrainingCard(value, { playerNames: names(2), chatName: 'Sunrise' });
    assert.match(text, /🟢 Запис відкрито\n6\/12/);
    assert.match(text, /1\. Гравець 1\n2\. \+1/);
    assert.match(text, /3\. Гравець 2\n4\. \+1\n5\. \+1\n6\. \+1/);
});
test('long lists truncate to ten and five and support complete view', () => {
    const value = training('open', 12, 7);
    const compact = renderTrainingCard(value, { playerNames: names(19), chatName: 'Sunrise' });
    assert.equal(isTrainingParticipantListTruncated(value), true);
    assert.match(compact, /10\. Гравець 10\n… ще 2/); assert.match(compact, /5\. Гравець 17\n… ще 2/);
    const full = renderTrainingCard(value, { playerNames: names(19), chatName: 'Sunrise', showAll: true });
    assert.match(full, /12\. Гравець 12/); assert.match(full, /7\. Гравець 19/); assert.doesNotMatch(full, /… ще/);
});
test('keyboard follows status, conditionally shows all, and has no refresh', () => {
    const open = labels(createTrainingKeyboard(training('open')));
    assert.deepEqual(open, ['➕ Додати', '➖ Прибрати', '✏️ Змінити', '🔒 Закрити запис', '❌ Скасувати', '◀️ До списку', '🏠 Меню']);
    assert.deepEqual(labels(createTrainingKeyboard(training('closed'))), ['➕ Додати', '➖ Прибрати', '✏️ Змінити', '🟢 Відкрити запис', '❌ Скасувати', '◀️ До списку', '🏠 Меню']);
    assert.deepEqual(labels(createTrainingKeyboard(training('cancelled'))), ['📋 Список', '◀️ До списку', '🏠 Меню']);
    assert.deepEqual(labels(createTrainingKeyboard(training('finished'))), ['◀️ До списку', '🏠 Меню']);
    assert.equal(labels(createTrainingKeyboard(training('open', 11), true))[0], '👥 Показати всіх');
    assert.ok(!open.some((label) => label.includes('Оновити') || label === '👥 Учасники'));
    const published = training('open'); published.messageId = 42;
    assert.ok(labels(createTrainingKeyboard(published)).includes('🔄 Перезібрати список з чату'));
    assert.equal(labels(createTrainingKeyboard(training('closed'))).includes('🔄 Перезібрати список з чату'), false);
});
test('player selection callback stays below Telegram limit with UUID ids', () => {
    const player = { id: `player_${'a'.repeat(36)}`, displayName: 'Player', aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' };
    const keyboard = createTrainingPlayerSearchKeyboard(`training_${'b'.repeat(36)}`, [player], 'add');
    const callback = keyboard.reply_markup.inline_keyboard[0][0];
    assert.ok('callback_data' in callback && Buffer.byteLength(callback.callback_data) <= 64);
});

test('every callback generated by training keyboards has a registered router handler', () => {
    const direct = new AdminTrainingHandler({
        adminUi: { setTrainingCardRenderer: () => undefined },
    } as any, {} as any);
    const flow = new TrainingFlowHandler({} as any, {} as any);
    const navigation = {
        canHandle: (callback: string) => callback === AdminCallbacks.MainMenu,
        handle: async () => undefined,
    };
    const value = training('open', 11);
    const player = { id: 'player_1', displayName: 'Player', aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' };
    const generated = [
        createActiveTrainingsKeyboard([value]),
        createTrainingKeyboard(value, true),
        createTrainingParticipantsKeyboard(value),
        createTrainingCancelKeyboard(value.id),
        createTrainingReconcileConfirmKeyboard(value.id),
        createTrainingPlayerSearchKeyboard(value.id, [player], 'add'),
        createTrainingPlayerSearchKeyboard(value.id, [player], 'remove'),
        createUnknownTrainingPlayerKeyboard(),
        createNewTrainingPlayerPreviewKeyboard(),
        createTrainingPlayerDuplicateKeyboard([player]),
        createArchivedTrainingsKeyboard([value]),
        createArchivedTrainingKeyboard(value, true),
    ].flatMap(callbacks);

    for (const callback of generated) {
        assert.ok(findCallbackHandler([flow, direct, navigation], callback), `unhandled generated callback: ${callback}`);
    }
});

test('training action prefixes are registered with their intended handlers', () => {
    const direct = new AdminTrainingHandler({ adminUi: { setTrainingCardRenderer: () => undefined } } as any, {} as any);
    const flow = new TrainingFlowHandler({} as any, {} as any);
    const directCallbacks = [
        AdminCallbacks.ActiveTrainings,
        AdminCallbacks.ArchivedTrainings,
        `${AdminCallbacks.ArchiveMonthPrefix}2026-08`,
        `${AdminCallbacks.ArchivedTrainingPrefix}training_1`,
        `${AdminCallbacks.TrainingPrefix}training_1`,
        `${AdminCallbacks.TrainingParticipantsPrefix}training_1`,
        `${AdminCallbacks.TrainingFinishPrefix}training_1`,
        `${AdminCallbacks.TrainingCancelPrefix}training_1`,
        `${AdminCallbacks.TrainingCancelConfirmPrefix}training_1`,
        `${AdminCallbacks.TrainingRefreshPrefix}training_1`,
        `${AdminCallbacks.TrainingReconcilePrefix}training_1`,
        `${AdminCallbacks.TrainingReconcileConfirmPrefix}training_1`,
        `${AdminCallbacks.TrainingClosePrefix}training_1`,
        `${AdminCallbacks.TrainingOpenPrefix}training_1`,
    ];
    const flowCallbacks = [
        AdminCallbacks.ArchiveSearch,
        `${AdminCallbacks.TrainingAddPlayerPrefix}training_1`,
        `${AdminCallbacks.TrainingRemovePlayerPrefix}training_1`,
        `${AdminCallbacks.TrainingSelectAddPlayerPrefix}player_1`,
        `${AdminCallbacks.TrainingSelectRemovePlayerPrefix}player_1`,
        AdminCallbacks.TrainingNewPlayerPreview,
        AdminCallbacks.TrainingNewPlayerEdit,
        AdminCallbacks.TrainingNewPlayerSearchAgain,
        AdminCallbacks.TrainingNewPlayerPlaces,
        AdminCallbacks.TrainingNewPlayerConfirm,
        AdminCallbacks.TrainingNewPlayerCreateAnyway,
        AdminCallbacks.TrainingNewPlayerCancel,
    ];

    for (const callback of directCallbacks) assert.equal(findCallbackHandler([flow, direct], callback), direct, callback);
    for (const callback of flowCallbacks) assert.equal(findCallbackHandler([flow, direct], callback), flow, callback);
});
