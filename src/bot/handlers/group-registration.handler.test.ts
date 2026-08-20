import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'telegraf';

import { ServicesContext } from '../../app/services.context';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';
import { Training } from '../../domain/trainings/training.types';
import { GroupRegistrationHandler } from './group-registration.handler';
import { RegistrationMessageCleanup } from '../registration/registration-message-cleanup';
import { PendingRegistrationSelectionStore, REGISTRATION_SELECTION_CANCEL_PREFIX, REGISTRATION_SELECTION_PREFIX } from '../registration/pending-registration-selection.store';

const training: Training = {
    id: 'training-a', clubId: 'club-a', chatId: -100, messageId: 42, title: 'Training', date: '2099-01-01',
    startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '', updatedAt: '',
};

function createHarness(options: { resolution?: unknown; executeError?: Error; deleteError?: Error } = {}) {
    let nextBotMessageId = 100;
    const replies: Array<{ text: string; messageId: number; extra: unknown }> = [];
    const deleted: Array<{ chatId: number; messageId: number }> = [];
    const refreshed: string[] = [];
    const executions: string[] = [];
    const registration = {
        resolveCommand: async () => options.resolution ?? ({ kind: 'ready', training }),
        executeCommandAgainstTraining: async (_input: unknown, trainingId: string) => {
            executions.push(trainingId);
            if (options.executeError) throw options.executeError;
            return [{ training }];
        },
    };
    const services = { repositories: { clubId: 'club-a' }, registration } as unknown as ServicesContext;
    const publisher = { refreshMessage: async (id: string) => { refreshed.push(id); } } as unknown as TrainingPublisherService;
    const cleanup = new RegistrationMessageCleanup(8, 50);
    const selections = new PendingRegistrationSelectionStore(50);
    const handler = new GroupRegistrationHandler(services, publisher, selections, cleanup);
    const telegram = {
        deleteMessage: async (chatId: number, messageId: number) => {
            deleted.push({ chatId, messageId });
            if (options.deleteError) throw options.deleteError;
        },
    };
    const messageContext = (text: string, userId = 1, updateId = nextBotMessageId) => ({
        from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' }, telegram,
        message: { message_id: updateId, text, from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' } },
        update: { update_id: updateId },
        reply: async (replyText: string, extra?: unknown) => {
            const messageId = nextBotMessageId++;
            replies.push({ text: replyText, messageId, extra });
            return { message_id: messageId, chat: { id: -100, type: 'supergroup' } };
        },
    } as unknown as Context);
    const callbackContext = (callback: string, userId = 1) => ({
        from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' }, telegram,
        callbackQuery: { id: 'callback', data: callback, from: { id: userId }, chat_instance: 'x', message: { message_id: replies.at(-1)?.messageId, chat: { id: -100, type: 'supergroup' }, date: 0 } },
        update: { update_id: 999, callback_query: {} }, answerCbQuery: async () => undefined,
    } as unknown as Context);
    const editedMessageContext = (text: string, messageId = 700, userId = 1, updateId = 1700) => ({
        from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' }, telegram,
        editedMessage: { message_id: messageId, text, edit_date: 1, date: 0, from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' } },
        update: { update_id: updateId, edited_message: {} },
        reply: async (replyText: string, extra?: unknown) => { const botMessageId = nextBotMessageId++; replies.push({ text: replyText, messageId: botMessageId, extra }); return { message_id: botMessageId, chat: { id: -100, type: 'supergroup' } }; },
    } as unknown as Context);
    return { handler, cleanup, replies, deleted, refreshed, executions, messageContext, editedMessageContext, callbackContext };
}

const waitForTimers = () => new Promise((resolve) => setTimeout(resolve, 20));

test('invalid +5 warning is deleted after TTL and the training card is never targeted', async () => {
    const h = createHarness();
    await h.handler.handle(h.messageContext('+5'));
    assert.equal(h.replies[0].text, 'Можна додати або зняти від 1 до 4 місць.');
    await waitForTimers();
    assert.deepEqual(h.deleted, [{ chatId: -100, messageId: h.replies[0].messageId }]);
    assert.equal(h.deleted.some((item) => item.messageId === training.messageId), false);
});

test('invalid unregistration quantity and another parse warning are temporary', async () => {
    const h = createHarness();
    await h.handler.handle(h.messageContext('-5', 1, 201));
    await h.handler.handle(h.messageContext('+2 Арсений, Александр, Вася', 1, 202));
    await waitForTimers();
    assert.equal(h.replies[0].text, 'Можна додати або зняти від 1 до 4 місць.');
    assert.equal(h.replies[1].text, 'Вказано 2 місця, але знайдено 3 імені.');
    assert.deepEqual(h.deleted.map((item) => item.messageId), h.replies.map((item) => item.messageId));
});

test('selector remains active, then is deleted after a successful choice while +1 behavior stays unchanged', async () => {
    const alternate = { ...training, id: 'training-b', startTime: '20:00', endTime: '22:00' };
    const h = createHarness({ resolution: { kind: 'select', trainings: [training, alternate] } });
    await h.handler.handle(h.messageContext('+1'));
    assert.equal(h.replies[0].text, '🏸 Оберіть тренування:');
    assert.equal(h.deleted.length, 0);
    const keyboard = (h.replies[0].extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }).reply_markup.inline_keyboard;
    await h.handler.handleSelection(h.callbackContext(keyboard[0][0].callback_data), keyboard[0][0].callback_data);
    assert.deepEqual(h.executions, ['training-a']);
    assert.deepEqual(h.refreshed, ['training-a']);
    assert.deepEqual(h.deleted, [{ chatId: -100, messageId: h.replies[0].messageId }]);
});

test('cancelled selector is cleaned up without executing registration', async () => {
    const h = createHarness({ resolution: { kind: 'select', trainings: [training, { ...training, id: 'training-b' }] } });
    await h.handler.handle(h.messageContext('-1'));
    const keyboard = (h.replies[0].extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }).reply_markup.inline_keyboard;
    const callback = keyboard.flat().map((button) => button.callback_data).find((value) => value.startsWith(REGISTRATION_SELECTION_CANCEL_PREFIX))!;
    await h.handler.handleSelection(h.callbackContext(callback), callback);
    assert.deepEqual(h.executions, []);
    assert.deepEqual(h.deleted, [{ chatId: -100, messageId: h.replies[0].messageId }]);
});

test('new prompt replaces only the same user prompt; users remain isolated', async () => {
    const h = createHarness({ resolution: { kind: 'select', trainings: [training, { ...training, id: 'training-b' }] } });
    await h.handler.handle(h.messageContext('+1', 1, 301));
    const userAFirst = h.replies[0].messageId;
    const oldCallback = ((h.replies[0].extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }).reply_markup.inline_keyboard[0][0].callback_data);
    await h.handler.handle(h.messageContext('+1', 2, 302));
    const userB = h.replies[1].messageId;
    assert.equal(h.deleted.length, 0);
    await h.handler.handle(h.messageContext('+1', 1, 303));
    assert.deepEqual(h.deleted, [{ chatId: -100, messageId: userAFirst }]);
    assert.equal(h.deleted.some((item) => item.messageId === userB), false);
    await h.handler.handleSelection(h.callbackContext(oldCallback, 1), oldCallback);
    assert.deepEqual(h.executions, [], 'replaced prompt callbacks are inactive');
});

test('Telegram deletion failure never propagates into registration or refresh', async () => {
    const h = createHarness({ resolution: { kind: 'select', trainings: [training, { ...training, id: 'training-b' }] }, deleteError: new Error('message to delete not found') });
    await h.handler.handle(h.messageContext('+1'));
    const keyboard = (h.replies[0].extra as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }).reply_markup.inline_keyboard;
    const callback = keyboard.flat().map((button) => button.callback_data).find((value) => value.startsWith(REGISTRATION_SELECTION_PREFIX))!;
    await assert.doesNotReject(h.handler.handleSelection(h.callbackContext(callback), callback));
    assert.deepEqual(h.executions, ['training-a']);
    assert.deepEqual(h.refreshed, ['training-a']);
});

test('normal +1 and -1 still execute and refresh the persistent training card', async () => {
    const h = createHarness();
    await h.handler.handle(h.messageContext('+1', 1, 501));
    await h.handler.handle(h.messageContext('-1', 1, 502));
    assert.deepEqual(h.executions, ['training-a', 'training-a']);
    assert.deepEqual(h.refreshed, ['training-a', 'training-a']);
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.deleted, []);
});

test('bare plus executes exactly like +1', async () => {
    const h = createHarness();
    await h.handler.handle(h.messageContext('+', 1, 503));
    assert.deepEqual(h.executions, ['training-a']);
    assert.deepEqual(h.refreshed, ['training-a']);
    assert.deepEqual(h.replies, []);
});

test('a message edited into bare plus is rechecked and processed as +1', async () => {
    const h = createHarness();
    await h.handler.handle(h.editedMessageContext('+'));
    assert.deepEqual(h.executions, ['training-a']);
    assert.deepEqual(h.refreshed, ['training-a']);
});

test('commands are silently ignored when no applicable active training exists', async () => {
    for (const text of ['+1', '+2', '+3', '+4', '-1', '-2', '-3', '-4', 'сьогодні 18:00 +1']) {
        const h = createHarness({ resolution: { kind: 'none', reason: 'NO_APPLICABLE_TRAINING' } });
        await h.handler.handle(h.messageContext(text));
        assert.deepEqual(h.replies, [], text);
        assert.deepEqual(h.executions, [], text);
        assert.deepEqual(h.refreshed, [], text);
        assert.deepEqual(h.deleted, [], text);
    }
});

test('unexpected registration errors are logged without a noisy public reply', async () => {
    const h = createHarness({ executeError: new Error('database unavailable') });
    await h.handler.handle(h.messageContext('+1'));
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.refreshed, []);
});
