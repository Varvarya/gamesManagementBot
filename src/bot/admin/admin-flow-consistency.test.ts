import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { AdminFlowService } from './flows/admin-flow.service';
import { AdminChatHandler } from './handlers/admin-chat.handler';
import { AdminCallbacks } from './callbacks/admin-callbacks';
import { createChatPreviewKeyboard } from './keyboards/chat.keyboard';
import { createPlayerPreviewKeyboard, createMergePreviewKeyboard } from './keyboards/player.keyboard';
import { createTemplatePreviewKeyboard } from './keyboards/template.keyboard';
import { createTrainingCancelKeyboard } from './keyboards/training.keyboard';

function labels(markup: { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }): string[] {
    return markup.reply_markup.inline_keyboard.flat().map((button) => button.text);
}

test('preview keyboards use consistent confirm, back and cancel actions', () => {
    for (const keyboard of [createChatPreviewKeyboard(), createPlayerPreviewKeyboard(), createTemplatePreviewKeyboard('create')]) {
        const actions = labels(keyboard as any);
        assert.ok(actions.some((label) => label.startsWith('✅ Підтвердити')));
        assert.ok(actions.some((label) => label.startsWith('◀️ Назад')));
        assert.ok(actions.some((label) => label.startsWith('❌ Скасувати')));
    }
    assert.ok(labels(createMergePreviewKeyboard('a', 'b') as any).some((label) => label.startsWith('✅ Підтвердити')));
    assert.ok(labels(createTrainingCancelKeyboard('t') as any).some((label) => label.startsWith('✅ Підтвердити')));
});

test('recoverable chat confirmation error keeps pending flow data for retry', async () => {
    const adminFlow = new AdminFlowService();
    adminFlow.start(1, 'waiting_chat_data', { pendingChatId: -1001, pendingChatName: 'Club' });
    let rendered = '';
    const services = {
        adminFlow,
        chats: { upsert: async () => { throw new Error('temporary write failure'); } },
        adminUi: { replaceWithError: async (_ctx: Context, text: string) => { rendered = text; } },
    } as unknown as ServicesContext;
    await new AdminChatHandler(services).handle({ from: { id: 1 } } as Context, AdminCallbacks.ConfirmAddChat);
    assert.equal(adminFlow.getState(1), 'waiting_chat_data');
    assert.equal(adminFlow.getData(1).pendingChatName, 'Club');
    assert.match(rendered, /temporary write failure/);
});
