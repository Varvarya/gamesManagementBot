import { Markup } from 'telegraf';

import { ChatConfig } from '../../../domain/chats/chat.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createChatsKeyboard(
    chats: ChatConfig[],
) {
    return Markup.inlineKeyboard([
        ...chats.map(chat => [
            Markup.button.callback(
                `${chat.enabled ? '🟢' : '⚪️'} ${chat.name}`,
                `${AdminCallbacks.ChatPrefix}${chat.id}`,
            ),
        ]),
        [
            Markup.button.callback(
                '➕ Додати чат',
                AdminCallbacks.AddChat,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createChatKeyboard(
    chat: ChatConfig,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                chat.enabled ? '⏸ Вимкнути' : '▶️ Увімкнути',
                `${AdminCallbacks.ChatTogglePrefix}${chat.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '🗑 Видалити',
                `${AdminCallbacks.ChatDeletePrefix}${chat.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ До чатів',
                AdminCallbacks.Chats,
            ),
        ],
    ]);
}

export function createChatDeleteKeyboard(
    chatId: number,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '✅ Підтвердити видалення',
                `${AdminCallbacks.ChatDeleteConfirmPrefix}${chatId}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                `${AdminCallbacks.ChatPrefix}${chatId}`,
            ),
        ],
    ]);
}

export function createChatPreviewKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Підтвердити', AdminCallbacks.ConfirmAddChat)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.AddChat)],
        [Markup.button.callback('❌ Скасувати', AdminCallbacks.Chats)],
    ]);
}
