import assert from 'node:assert/strict';
import test from 'node:test';
import { Player } from '../players/player.types';
import { TrainingMessageRenderer } from './training-message.renderer';
import { ParticipantEntry, Training } from './training.types';

const player = (id: string, displayName: string): Player => ({ id, displayName, aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' });
const entry = (id: string, playerId: string, status: ParticipantEntry['status'], displayName = `Snapshot ${playerId}`): ParticipantEntry => ({ id, playerId, displayName, places: 1, source: 'telegram', status, createdAt: '', updatedAt: '' });
const training = (overrides: Partial<Training> = {}): Training => ({ id: 't', clubId: 'c', chatId: -1, title: 'Вечірнє тренування', location: 'Зал 1', date: '2026-08-04', startTime: '19:00', endTime: '21:00', placesLimit: 3, minPlayers: 2, status: 'open', participants: [entry('e1', 'p1', 'active'), entry('e2', 'p2', 'active')], waitlist: [entry('e3', 'p3', 'waiting')], createdAt: '', updatedAt: '', ...overrides });

test('renders formatted header, capacity, numbered main list and separate waitlist', () => {
    const message = new TrainingMessageRenderer().render({ training: training(), players: [player('p1', 'Олена'), player('p2', 'Іван'), player('p3', 'Марія')] });
    assert.match(message, /^🏸 Вечірнє тренування\n📅 04\.08\.2026\n🕒 19:00–21:00\n📍 Зал 1/m);
    assert.match(message, /🟢 Статус: запис відкрито/);
    assert.match(message, /👥 Записано: 2 \/ 3/);
    assert.match(message, /⏳ У листі очікування: 1/);
    assert.match(message, /🪑 Вільно: 1/);
    assert.match(message, /🎯 Мінімум гравців: 2/);
    assert.match(message, /✅ Основний список\n1\. Олена\n2\. Іван\n\n⏳ Лист очікування\n1\. Марія/);
});

test('renders empty sections and closed training status', () => {
    const message = new TrainingMessageRenderer().render({ training: training({ status: 'closed', location: undefined, participants: [], waitlist: [] }), players: [] });
    assert.match(message, /🔒 Статус: запис закрито/);
    assert.match(message, /👥 Записано: 0 \/ 3/);
    assert.match(message, /🪑 Вільно: 3/);
    assert.match(message, /✅ Основний список\n—\n\n⏳ Лист очікування\n—/);
    assert.doesNotMatch(message, /📍/);
});

test('shows full open training status without changing waitlist data', () => {
    const message = new TrainingMessageRenderer().render({ training: training({ placesLimit: 2 }), players: [player('p1', 'Олена'), player('p2', 'Іван'), player('p3', 'Марія')] });
    assert.match(message, /🟡 Статус: основний список заповнено/);
    assert.match(message, /🪑 Вільно: 0/);
    assert.match(message, /⏳ У листі очікування: 1/);
});

test('prefers current player name, then snapshot, then generic fallback', () => {
    const snapshot = entry('e1', 'missing', 'active', 'Історичне імʼя');
    const legacy = { ...entry('e2', 'also-missing', 'active'), displayName: undefined } as unknown as ParticipantEntry;
    const current = entry('e3', 'current', 'active', 'Старе імʼя');
    const message = new TrainingMessageRenderer().render({
        training: training({ participants: [snapshot, legacy, current], waitlist: [] }),
        players: [player('current', 'Нове імʼя')],
    });
    assert.match(message, /1\. Історичне імʼя/);
    assert.match(message, /2\. Гравець/);
    assert.match(message, /3\. Нове імʼя/);
    assert.doesNotMatch(message, /Unknown player|Невідомий гравець/);
});
