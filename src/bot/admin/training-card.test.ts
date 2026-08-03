import assert from 'node:assert/strict';
import test from 'node:test';
import { Training, ParticipantEntry } from '../../domain/trainings/training.types';
import { createTrainingKeyboard, createTrainingPlayerSearchKeyboard } from './keyboards/training.keyboard';
import { isTrainingParticipantListTruncated, renderTrainingCard } from './ui/admin-formatters';

function entry(index: number, status: ParticipantEntry['status'] = 'active'): ParticipantEntry {
    return { id: `e${index}`, playerId: `p${index}`, displayName: `Snapshot ${index}`, places: 1, source: 'admin', status, createdAt: '', updatedAt: '' };
}
function training(status: Training['status'] = 'open', participants = 0, waiting = 0): Training {
    return { id: 'training_123', clubId: 'club', chatId: -1001, title: 'Ранкові тренування', date: '2026-08-04', startTime: '08:30', endTime: '10:30', placesLimit: 12, minPlayers: 4, status, participants: Array.from({ length: participants }, (_, i) => entry(i + 1)), waitlist: Array.from({ length: waiting }, (_, i) => entry(participants + i + 1, 'waiting')), createdAt: '', updatedAt: '' };
}
const names = (count: number) => new Map(Array.from({ length: count }, (_, i) => [`p${i + 1}`, `Гравець ${i + 1}`]));
const labels = (keyboard: ReturnType<typeof createTrainingKeyboard>) => keyboard.reply_markup.inline_keyboard.flat().map((button) => 'text' in button ? button.text : '');

test('training card embeds empty lists and resolves saved chat name', () => {
    const text = renderTrainingCard(training(), { playerNames: names(0), chatName: 'Sunrise' });
    assert.match(text, /💬 Sunrise/); assert.doesNotMatch(text, /-1001/);
    assert.match(text, /👥 Учасники \(0\/12\)\n—/); assert.match(text, /🟡 Черга \(0\)\n—/);
});
test('participant and waitlist order and names are shown directly', () => {
    const text = renderTrainingCard(training('open', 3, 2), { playerNames: names(5), chatName: 'Sunrise' });
    assert.match(text, /1\. Гравець 1\n2\. Гравець 2\n3\. Гравець 3/);
    assert.match(text, /🟡 Черга \(2\)\n1\. Гравець 4\n2\. Гравець 5/);
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
    assert.deepEqual(open, ['➕ Додати', '➖ Прибрати', '🔒 Закрити запис', '❌ Скасувати', '✅ Завершити', '◀️ До списку', '🏠 Меню']);
    assert.deepEqual(labels(createTrainingKeyboard(training('closed'))), ['➕ Додати', '➖ Прибрати', '🟢 Відкрити запис', '❌ Скасувати', '✅ Завершити', '◀️ До списку', '🏠 Меню']);
    for (const status of ['cancelled', 'finished'] as const) assert.deepEqual(labels(createTrainingKeyboard(training(status))), ['◀️ До списку', '🏠 Меню']);
    assert.equal(labels(createTrainingKeyboard(training('open', 11), true))[0], '👥 Показати всіх');
    assert.ok(!open.some((label) => label.includes('Оновити') || label === '👥 Учасники'));
});
test('player selection callback stays below Telegram limit with UUID ids', () => {
    const player = { id: `player_${'a'.repeat(36)}`, displayName: 'Player', aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' };
    const keyboard = createTrainingPlayerSearchKeyboard(`training_${'b'.repeat(36)}`, [player], 'add');
    const callback = keyboard.reply_markup.inline_keyboard[0][0];
    assert.ok('callback_data' in callback && Buffer.byteLength(callback.callback_data) <= 64);
});
