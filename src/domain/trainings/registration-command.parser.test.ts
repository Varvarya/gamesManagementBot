import assert from 'node:assert/strict';
import test from 'node:test';

import { PlayerService } from '../players/player.service';
import { RegistrationCommandParser } from './registration-command.parser';
import { RegistrationService } from './registration.service';
import { TrainingParticipantsService } from './training-participants.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';

const parser = new RegistrationCommandParser();

test('messy registration commands are parsed as independent action, date, time, and name concepts', () => {
    const cases: Array<{
        text: string; operation: 'add' | 'remove'; count: number; day?: 'today' | 'tomorrow'; date?: string; time?: string; names?: string[];
    }> = [
        { text: 'сегодня 17-30, +4  )))', operation: 'add', count: 4, day: 'today', time: '17:30' },
        { text: 'сьогодні 17:30 +1', operation: 'add', count: 1, day: 'today', time: '17:30' },
        { text: '+1 сьогодні на 19:30', operation: 'add', count: 1, day: 'today', time: '19:30' },
        { text: 'завтра в 18 +2', operation: 'add', count: 2, day: 'tomorrow', time: '18:00' },
        { text: '20.08 +1', operation: 'add', count: 1, date: '20.08' },
        { text: '+1 20.08 18:30', operation: 'add', count: 1, date: '20.08', time: '18:30' },
        { text: '+1 Саша', operation: 'add', count: 1, names: ['Саша'] },
        { text: 'сьогодні +1 Олександр', operation: 'add', count: 1, day: 'today', names: ['Олександр'] },
        { text: '+1 Олександр на 17:30', operation: 'add', count: 1, time: '17:30', names: ['Олександр'] },
        { text: '+2 Арсений, Александр', operation: 'add', count: 2, names: ['Арсений', 'Александр'] },
        { text: '+1 дякую', operation: 'add', count: 1 },
        { text: '+1 будь ласка', operation: 'add', count: 1 },
        { text: '+1 пожалуйста', operation: 'add', count: 1 },
        { text: '+1 🙏', operation: 'add', count: 1 },
        { text: '+1)))', operation: 'add', count: 1 },
        { text: '-1 я', operation: 'remove', count: 1 },
        { text: '-1 мене', operation: 'remove', count: 1 },
        { text: 'сегодня -1 пожалуйста', operation: 'remove', count: 1, day: 'today' },
        { text: '20.08 18-30 -2', operation: 'remove', count: 2, date: '20.08', time: '18:30' },
        { text: '+1 на 12', operation: 'add', count: 1, time: '12:00' },
        { text: '+1 17-30', operation: 'add', count: 1, time: '17:30' },
        { text: '+1 20.08', operation: 'add', count: 1, date: '20.08' },
    ];
    for (const expected of cases) {
        const command = parser.parse(expected.text)!;
        assert.equal(command.operation, expected.operation, expected.text);
        assert.equal(command.count, expected.count, expected.text);
        assert.equal(command.trainingHint?.naturalDate, expected.day, expected.text);
        assert.equal(command.trainingHint?.date, expected.date, expected.text);
        assert.equal(command.trainingHint?.time, expected.time, expected.text);
        assert.deepEqual(command.targetNames, expected.names ?? [], expected.text);
        assert.equal(command.hasExplicitDate, Boolean(expected.day || expected.date), expected.text);
        assert.equal(command.hasExplicitTime, Boolean(expected.time), expected.text);
    }
});

test('date variants, time ranges, action spacing, arbitrary order, and ordinary-chat guard remain supported', () => {
    const dates = new Map([
        ['20.08', '20.08'], ['20.08.', '20.08'], ['20/08', '20.08'], ['20-08', '20.08'],
        ['20.08.2026', '2026-08-20'], ['20/08/2026', '2026-08-20'], ['20-08-2026', '2026-08-20'],
    ]);
    for (const [input, expected] of dates) assert.equal(parser.parse(`${input} +1`)?.trainingHint?.date, expected, input);
    for (const text of ['я +1', '+1 я', 'на завтра + 1 будь ласка', '17:30 +1', 'Саша +1 20.08', '+1 Саша на 20.08']) assert.ok(parser.parse(text), text);
    for (const text of ['звичайна розмова 17:30', 'рахунок 1+1', 'температура -8', 'C++']) assert.equal(parser.parse(text), undefined, text);
    assert.equal(parser.parse('+1 18:00-20:00')?.trainingHint?.endTime, '20:00');
});

test('critical messy command constrains the existing resolver to the unique club-local training', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const makeTraining = (id: string, startTime: string): Training => ({
        id, clubId: 'club', chatId: -100, title: id, date: today, startTime, endTime: '21:00', placesLimit: 12, minPlayers: 1,
        status: 'open', participants: [], waitlist: [], createdAt: '', updatedAt: '',
    });
    const trainings = [makeTraining('early', '17:30'), makeTraining('late', '19:30')];
    const trainingApi = {
        listRelevantOpenByChatId: async () => trainings,
        isRelevantOpen: () => true,
    } as unknown as TrainingService;
    const service = new RegistrationService(
        {} as PlayerService,
        trainingApi,
        {} as TrainingParticipantsService,
        async () => 'Europe/Kyiv',
    );
    const command = parser.parse('сегодня 17-30, +4  )))')!;
    const resolution = await service.resolveCommand({ telegramUser: { id: 7 }, chatId: -100, command });
    assert.equal(resolution.kind === 'ready' && resolution.training.id, 'early');
    assert.deepEqual(command.targetNames, []);
});
