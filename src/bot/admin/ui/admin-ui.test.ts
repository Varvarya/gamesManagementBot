import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'telegraf';
import { AdminUi } from './admin-ui';
import { AdminFlowService } from '../flows/admin-flow.service';
import { AdminMenuHandler } from '../handlers/admin-menu.handler';
import { ServicesContext } from '../../../app/services.context';

function privateContext(options: { messageId?: number; callbackMessageId?: number; replyIds?: number[]; editError?: Error; deleteError?: Error }) {
    const deleted: number[] = [];
    const edited: number[] = [];
    const replyIds = [...(options.replyIds ?? [])];
    const ctx = {
        from: { id: 7 }, chat: { id: 70, type: 'private' },
        message: options.messageId === undefined ? undefined : { message_id: options.messageId, text: 'input' },
        callbackQuery: options.callbackMessageId === undefined ? undefined : { id: 'cb', message: { message_id: options.callbackMessageId } },
        telegram: {
            deleteMessage: async (_chatId: number, messageId: number) => { deleted.push(messageId); if (options.deleteError) throw options.deleteError; },
            editMessageText: async (_chatId: number, messageId: number) => { edited.push(messageId); if (options.editError) throw options.editError; },
        },
        reply: async () => ({ message_id: replyIds.shift() ?? 999 }),
        editMessageText: async () => { if (options.editError) throw options.editError; return true; },
        answerCbQuery: async () => undefined,
    } as unknown as Context;
    return { ctx, deleted, edited };
}

test('flow user and bot messages are removed when root menu is reopened', async () => {
    const ui = new AdminUi();
    await ui.showRootMenu(privateContext({ messageId: 1, replyIds: [100] }).ctx, 'root');
    ui.trackUserMessage(7, 70, 10);
    ui.trackUserMessage(7, 70, 11);
    const flow = privateContext({ replyIds: [101, 102] });
    await ui.show(flow.ctx, 'step one');
    await ui.show(flow.ctx, 'step two');
    const root = privateContext({ callbackMessageId: 100 });
    await ui.showRootMenu(root.ctx, 'root again');
    assert.deepEqual(new Set(root.deleted), new Set([10, 11, 101, 102]));
    assert.deepEqual(root.edited, [100]);
});

test('ordinary nested rendering never triggers full cleanup', async () => {
    const ui = new AdminUi();
    ui.trackUserMessage(7, 70, 10);
    const nested = privateContext({ callbackMessageId: 100 });
    await ui.show(nested.ctx, 'nested back');
    assert.deepEqual(nested.deleted, []);
});

test('missing tracked messages and message-not-modified are harmless', async () => {
    const ui = new AdminUi();
    await ui.showRootMenu(privateContext({ replyIds: [100] }).ctx, 'root');
    ui.trackUserMessage(7, 70, 10);
    const root = privateContext({ callbackMessageId: 100, deleteError: new Error('message to delete not found'), editError: new Error('message is not modified') });
    await assert.doesNotReject(() => ui.showRootMenu(root.ctx, 'root'));
});

test('editing an already deleted old card is harmless', async () => {
    const ui = new AdminUi();
    const old = privateContext({ callbackMessageId: 100, editError: new Error('message to edit not found') });
    await assert.doesNotReject(() => ui.show(old.ctx, 'updated'));
});

test('tracked private training card is edited automatically from fresh renderer', async () => {
    const ui = new AdminUi();
    let renders = 0;
    ui.setTrainingCardRenderer(async () => ({ text: `fresh ${++renders}` }));
    const card = privateContext({ callbackMessageId: 100 });
    await ui.showTrainingCard(card.ctx, 'training-1', 'initial');
    await ui.refreshTrainingCards('training-1');
    assert.deepEqual(card.edited, [100]);
    assert.equal(renders, 1);
});

test('group messages are never deleted', async () => {
    const ui = new AdminUi();
    const deleted: number[] = [];
    const ctx = { from: { id: 7 }, chat: { id: -70, type: 'group' }, message: { message_id: 10 }, telegram: { deleteMessage: async (_chat: number, id: number) => deleted.push(id) }, reply: async () => ({ message_id: 100 }) } as unknown as Context;
    ui.trackUserMessage(7, -70, 10);
    await ui.showRootMenu(ctx, 'root');
    assert.deepEqual(deleted, []);
});

test('opening MainMenu finishes an active flow', async () => {
    const adminFlow = new AdminFlowService();
    adminFlow.start(7, 'waiting_player_name');
    const services = { adminFlow, adminUi: { showRootMenu: async () => undefined }, repositories: { settings: { get: async () => ({ title: 'Club' }) }, trainings: { listActive: async () => [] }, players: { listUnconfirmed: async () => [] }, templates: { list: async () => [] } }, chats: { getAll: async () => [] } } as unknown as ServicesContext;
    await new AdminMenuHandler(services).showMain(privateContext({}).ctx);
    assert.equal(adminFlow.getState(7), 'idle');
});
