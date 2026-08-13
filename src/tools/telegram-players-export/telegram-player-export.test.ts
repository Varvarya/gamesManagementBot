import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerCsvParser } from '../../domain/players/player-csv';
import { TelegramPlayerCandidateBuilder } from './telegram-player-candidate';
import { TelegramPlayerCsvWriter } from './telegram-player-csv';

test('contacts match only by Telegram ID and Telegram name becomes an alias', () => {
    const result = new TelegramPlayerCandidateBuilder().build(
        [{ telegramUserId: 123, firstName: 'Папаня' }],
        [{ userId: 123, firstName: 'Євген Мухін' }],
    );
    assert.deepEqual(result.candidates[0], {
        telegramUserId: 123, telegramFirstName: 'Папаня', telegramLastName: undefined, telegramUsername: undefined,
        telegramDisplayName: 'Папаня', contactFirstName: 'Євген Мухін', contactLastName: undefined,
        contactDisplayName: 'Євген Мухін', suggestedDisplayName: 'Євген Мухін', aliases: ['Папаня'], isContact: true, needsReview: false,
    });
    const wrongId = new TelegramPlayerCandidateBuilder().build(
        [{ telegramUserId: 124, firstName: 'Папаня' }],
        [{ userId: 999, firstName: 'Євген Мухін' }],
    ).candidates[0];
    assert.equal(wrongId.suggestedDisplayName, 'Папаня');
    assert.equal(wrongId.isContact, false);
});

test('no contact keeps Telegram name, same names do not create aliases, suspicious names remain for review', () => {
    const builder = new TelegramPlayerCandidateBuilder();
    const normal = builder.build([{ telegramUserId: 456, firstName: 'Олександр', lastName: 'Петренко' }], []).candidates[0];
    assert.equal(normal.suggestedDisplayName, 'Олександр Петренко'); assert.deepEqual(normal.aliases, []); assert.equal(normal.needsReview, false);
    const same = builder.build([{ telegramUserId: 1, firstName: 'Марія' }], [{ userId: 1, firstName: 'Марія' }]).candidates[0];
    assert.deepEqual(same.aliases, []);
    const suspicious = builder.build([{ telegramUserId: 789, firstName: '😈' }], []).candidates[0];
    assert.equal(suspicious.suggestedDisplayName, '😈'); assert.equal(suspicious.needsReview, true);
    for (const valid of ['Єва', 'Ян', 'Li', 'Бо']) assert.equal(builder.build([{ telegramUserId: 2, firstName: valid }], []).candidates[0].needsReview, false, valid);
});

test('bots, deleted accounts and duplicate IDs are excluded deterministically', () => {
    const result = new TelegramPlayerCandidateBuilder().build([
        { telegramUserId: 1, firstName: 'Bot', bot: true }, { telegramUserId: 2, firstName: 'Deleted', deleted: true },
        { telegramUserId: 3, firstName: 'Марія' }, { telegramUserId: 3, firstName: 'Duplicate' },
    ], []);
    assert.deepEqual(result.candidates.map((item) => item.telegramUserId), [3]);
    assert.equal(result.botCount, 1); assert.equal(result.deletedCount, 1); assert.equal(result.duplicateCount, 1);
});

test('CSV is UTF-8 BOM, safely escaped and directly accepted by the existing importer', () => {
    const candidates = new TelegramPlayerCandidateBuilder().build([
        { telegramUserId: 10, firstName: 'Марія, "Зірка" ✨', username: '@maria' },
        { telegramUserId: 11, firstName: 'ОʼConnor' },
    ], []).candidates;
    const csv = new TelegramPlayerCsvWriter().serialize(candidates);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.match(csv, /"Марія, ""Зірка"" ✨"/);
    const parsed = new PlayerCsvParser().parse(csv);
    assert.equal(parsed.errors.length, 0); assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows.find((row) => row.telegramUserId === 10)?.telegramUsername, 'maria');
});
