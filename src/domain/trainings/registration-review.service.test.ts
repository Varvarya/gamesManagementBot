import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Telegram } from 'telegraf';

import { JsonStorage } from '../../storage/jsonStorage';
import { PlayerService } from '../players/player.service';
import { RegistrationCommandParser } from './registration-command.parser';
import { RegistrationReviewService, registrationReviewRecipients } from './registration-review.service';
import { RegistrationService } from './registration.service';
import { TrainingParticipantsService } from './training-participants.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';

const parser = new RegistrationCommandParser();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const training = (id: string, startTime: string): Training => ({ id, clubId: 'club', chatId: -100, messageId: 42, title: id, date: today(), startTime, endTime: '20:00', placesLimit: 20, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '', publishedAt: '', updatedAt: '' });

test('resolver prioritizes a sole target and reviews noisy time only when multiple targets exist', async () => {
    let values = [training('evening', '18:00')];
    const trainings = { listRelevantOpenByChatId: async () => values } as unknown as TrainingService;
    const service = new RegistrationService({} as PlayerService, trainings, {} as TrainingParticipantsService, async () => 'Europe/Kyiv');
    const resolve = (text: string) => service.resolveCommand({ telegramUser: { id: 1 }, chatId: -100, command: parser.parse(text)! });
    assert.equal((await resolve('сегодня 18:00 +1')).kind, 'ready');
    assert.equal((await resolve('сегодня +1')).kind, 'ready');
    const near = await resolve('сегодня 17-30, +4  )))');
    assert.equal(near.kind, 'ready');
    assert.equal(near.kind === 'ready' && near.training.id, 'evening');
    assert.equal((await resolve('сегодня 16:00 +1')).kind, 'ready', 'a noisy time cannot eliminate the sole real target');
    values = [training('early', '17:00'), training('late', '18:00')];
    const multiple = await resolve('сегодня 17:30 +1');
    assert.equal(multiple.kind, 'suspicious');
    assert.equal(multiple.kind === 'suspicious' && multiple.reason, 'MULTIPLE_NEAR_MATCHES');
});

test('one shared review goes only to admins, is idempotent by source, and synchronizes all messages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registration-review-'));
    const sent: number[] = []; const edited: number[] = []; let next = 10;
    const telegram = {
        sendMessage: async (chatId: number) => { sent.push(chatId); return { message_id: next++, chat: { id: chatId, type: 'private' } }; },
        editMessageText: async (_chatId: number, messageId: number) => { edited.push(messageId); return true; },
    } as unknown as Telegram;
    const service = new RegistrationReviewService(new JsonStorage({ dataDir: root, storageSlug: '_system' }), telegram);
    const admins = registrationReviewRecipients([{ telegramUserId: 1, role: 'owner' }, { telegramUserId: 2, role: 'admin' }, { telegramUserId: 3, role: 'admin' }]);
    assert.deepEqual(admins, [2, 3]);
    const command = parser.parse('сегодня 17-30, +4  )))')!; const candidate = training('evening', '18:00');
    const input = { clubId: 'club', sourceChatId: -100, sourceMessageId: 101, sourceText: 'сегодня 17-30, +4  )))', telegramUser: { id: 7, first_name: 'User' }, parsedCommand: command, candidateTrainingIds: [candidate.id], suggestedTrainingId: candidate.id, reason: 'TIME_NEAR_MATCH' as const };
    const first = await service.createOrGet(input, admins, [candidate]);
    const second = await service.createOrGet(input, admins, [candidate]);
    assert.equal(first.id, second.id);
    assert.deepEqual(sent, [2, 3]);
    const restartedSends: number[] = [];
    const restartedTelegram = { sendMessage: async (chatId: number) => { restartedSends.push(chatId); return { message_id: 99, chat: { id: chatId } }; }, editMessageText: async () => true } as unknown as Telegram;
    const restarted = new RegistrationReviewService(new JsonStorage({ dataDir: root, storageSlug: '_system' }), restartedTelegram);
    const recoveredAgain = await restarted.createOrGet(input, admins, [candidate]);
    assert.equal(recoveredAgain.id, first.id, 'recovery after restart reuses the source-message review');
    assert.deepEqual(restartedSends, [], 'recovery never sends a duplicate review');
    let mutations = 0;
    const [a, b] = await Promise.all([
        service.resolve(first.id, { id: 2, name: 'Admin A' }, { type: 'accept', trainingId: candidate.id }, async () => { mutations++; }),
        service.resolve(first.id, { id: 3, name: 'Admin B' }, { type: 'accept', trainingId: candidate.id }, async () => { mutations++; }),
    ]);
    assert.equal(mutations, 1, 'two accepts can never apply +4 twice');
    assert.deepEqual([a, b].sort(), ['already_resolved', 'resolved']);
    assert.deepEqual(edited.sort((x, y) => x - y), [10, 11]);
});

test('first conflicting accept/reject decision wins without rollback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registration-review-conflict-'));
    const telegram = { sendMessage: async (chatId: number) => ({ message_id: chatId, chat: { id: chatId } }), editMessageText: async () => true } as unknown as Telegram;
    const service = new RegistrationReviewService(new JsonStorage({ dataDir: root, storageSlug: '_system' }), telegram);
    const candidate = training('evening', '18:00'); const command = parser.parse('сегодня 17:30 +4')!;
    const review = await service.createOrGet({ clubId: 'club', sourceChatId: -100, sourceMessageId: 200, sourceText: 'x', telegramUser: { id: 7 }, parsedCommand: command, candidateTrainingIds: [candidate.id], suggestedTrainingId: candidate.id, reason: 'TIME_NEAR_MATCH' }, [2, 3], [candidate]);
    let mutations = 0;
    const results = await Promise.all([
        service.resolve(review.id, { id: 2, name: 'A' }, { type: 'accept', trainingId: candidate.id }, async () => { mutations++; }),
        service.resolve(review.id, { id: 3, name: 'B' }, { type: 'reject' }, async () => { mutations++; }),
    ]);
    assert.deepEqual(results.sort(), ['already_resolved', 'resolved']);
    assert.ok(mutations === 0 || mutations === 1, 'the winning decision is applied at most once');
});
