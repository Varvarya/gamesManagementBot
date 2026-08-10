import { Context } from 'telegraf';

import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import {
    createChatDeleteKeyboard,
    createChatKeyboard,
    createChatsKeyboard,
    createChatPreviewKeyboard,
} from '../keyboards/chat.keyboard';
import { renderChatCard } from '../ui/admin-formatters';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { AdminFlowState } from '../flows/admin-flow.types';

export class AdminChatHandler {
    readonly messageStates: readonly AdminFlowState[] = ['waiting_chat_data'];
    constructor(
        private readonly services: ServicesContext,
    ) {}

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.Chats ||
            callback === AdminCallbacks.AddChat ||
            callback === AdminCallbacks.ConfirmAddChat ||
            callback.startsWith(
                AdminCallbacks.ChatPrefix,
            )
        );
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (callback === AdminCallbacks.Chats) {
            if (ctx.from) {
                this.services.adminFlow.finish(ctx.from.id);
            }
            await this.showChats(ctx);
            return;
        }

        if (callback === AdminCallbacks.AddChat) {
            try {
                await this.startAddChat(ctx);
            } catch (error) {
                console.error(
                    '[AdminChatHandler] Failed to start add-chat flow',
                    error,
                );

                await this.services.adminUi.replaceWithError(
                    ctx,
                    error instanceof Error
                        ? error.message
                        : 'Не вдалося відкрити додавання чату.',
                    createFlowCancelKeyboard(
                        AdminCallbacks.Chats,
                    ),
                );
            }

            return;
        }

        if (callback === AdminCallbacks.ConfirmAddChat) {
            const adminId = ctx.from?.id;
            if (!adminId) return;
            const data = this.services.adminFlow.getData(adminId);
            if (!data.pendingChatName || data.pendingChatId === undefined) {
                await this.services.adminUi.replaceWithError(ctx, 'Дані вже неактуальні. Додайте чат ще раз.', createFlowCancelKeyboard(AdminCallbacks.Chats));
                return;
            }
            try {
                const chat = await this.services.chats.upsert({ id: data.pendingChatId, name: data.pendingChatName });
                this.services.adminFlow.finish(adminId);
                await this.services.adminUi.replaceWithSuccess(ctx, `Чат додано.\n\n${renderChatCard(chat)}`, createChatKeyboard(chat));
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося додати чат. Спробуйте ще раз.', createChatPreviewKeyboard());
            }
            return;
        }

        // Specific prefixes must be checked before the generic ChatPrefix.
        if (
            callback.startsWith(
                AdminCallbacks.ChatDeleteConfirmPrefix,
            )
        ) {
            const chatId = this.parseChatId(
                callback,
                AdminCallbacks.ChatDeleteConfirmPrefix,
            );
            if (chatId === undefined) return;

            const references = (await this.services.templates.listByClubId(
                this.services.repositories.clubId,
            )).filter((template) => template.chatId === chatId);
            if (references.length) {
                await this.services.adminUi.replaceWithError(
                    ctx,
                    `Чат використовується у ${references.length} шаблон(ах). Спочатку виберіть інший чат або видаліть ці шаблони.`,
                    createChatKeyboard(await this.services.chats.getRequired(chatId)),
                );
                return;
            }

            await this.services.chats.delete(chatId);
            await this.services.adminUi.replaceWithSuccess(ctx, 'Чат видалено.', createChatsKeyboard(await this.services.chats.getAll()));
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.ChatDeletePrefix,
            )
        ) {
            const chatId = this.parseChatId(
                callback,
                AdminCallbacks.ChatDeletePrefix,
            );
            if (chatId === undefined) return;

            const chat = await this.services.chats.getRequired(chatId);
            await this.services.adminUi.show(
                ctx,
                [
                    '🗑 Видалити чат?',
                    '',
                    chat.name,
                    `Telegram ID: ${chat.id}`,
                    '',
                    'Цю дію неможливо скасувати.',
                ].join('\n'),
                createChatDeleteKeyboard(chat.id),
            );
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.ChatTogglePrefix,
            )
        ) {
            const chatId = this.parseChatId(
                callback,
                AdminCallbacks.ChatTogglePrefix,
            );
            if (chatId === undefined) return;

            const chat = await this.services.chats.toggle(chatId);
            await this.services.adminUi.replaceWithSuccess(
                ctx,
                `${chat.enabled ? 'Чат увімкнено.' : 'Чат вимкнено.'}\n\n${renderChatCard(chat)}`,
                createChatKeyboard(chat),
            );
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.ChatPrefix,
            )
        ) {
            if (ctx.from) this.services.adminFlow.finish(ctx.from.id);
            const chatId = this.parseChatId(
                callback,
                AdminCallbacks.ChatPrefix,
            );
            if (chatId === undefined) return;

            const chat = await this.services.chats.getRequired(chatId);
            await this.services.adminUi.show(
                ctx,
                renderChatCard(chat),
                createChatKeyboard(chat),
            );
        }
    }

    canHandleMessage(adminId: number): boolean {
        return this.services.adminFlow.getState(adminId) ===
            'waiting_chat_data';
    }

    async handleMessage(ctx: Context): Promise<boolean> {
        const adminId = ctx.from?.id;
        const message = ctx.message;

        if (
            !adminId ||
            !message ||
            !this.canHandleMessage(adminId)
        ) {
            return false;
        }

        if ('forward_origin' in message && message.forward_origin) {
            const origin = message.forward_origin;

            if (origin.type === 'hidden_user') {
                await this.showManualInputRequired(ctx);
                return true;
            }

            if (origin.type === 'user' || origin.type === 'channel') {
                await this.services.adminUi.replaceWithError(
                    ctx,
                    'Повідомлення має бути переслане з групи або супергрупи. Приватні чати, користувачі та канали не підтримуються.',
                    createFlowCancelKeyboard(AdminCallbacks.Chats),
                );
                return true;
            }

            const source = origin.sender_chat;
            if (
                source.type !== 'group' &&
                source.type !== 'supergroup'
            ) {
                await this.services.adminUi.replaceWithError(
                    ctx,
                    'Джерелом має бути група або супергрупа.',
                    createFlowCancelKeyboard(AdminCallbacks.Chats),
                );
                return true;
            }

            await this.previewChat(ctx, adminId, source.title, source.id);
            return true;
        }

        const legacySource = this.getLegacyForwardChat(message);
        if (legacySource) {
            if (
                legacySource.type !== 'group' &&
                legacySource.type !== 'supergroup'
            ) {
                await this.services.adminUi.replaceWithError(
                    ctx,
                    'Пересилання з каналів не підтримуються.',
                    createFlowCancelKeyboard(AdminCallbacks.Chats),
                );
                return true;
            }
            await this.previewChat(ctx, adminId, legacySource.title, legacySource.id);
            return true;
        }

        if ('text' in message) {
            const input = this.parseManualInput(message.text);
            if (!input) {
                await this.services.adminUi.replaceWithError(
                    ctx,
                    'Невірний формат. Надішліть непорожню назву та відʼємний Telegram ID окремими рядками:\n\nНазва чату\n-1001234567890',
                    createFlowCancelKeyboard(AdminCallbacks.Chats),
                );
                return true;
            }
            await this.previewChat(ctx, adminId, input.name, input.id);
            return true;
        }

        await this.showManualInputRequired(ctx);
        return true;
    }

    private async startAddChat(ctx: Context): Promise<void> {
        const adminId = ctx.from?.id;
        if (!adminId) return;

        this.services.adminFlow.start(adminId, 'waiting_chat_data');
        await this.services.adminUi.show(
            ctx,
            [
                '➕ Додати чат',
                '',
                'Перешліть сюди будь-яке повідомлення з потрібної Telegram-групи.',
                '',
                'Якщо Telegram приховує джерело, надішліть дані вручну:',
                '',
                'Назва чату',
                '-1001234567890',
            ].join('\n'),
            createFlowCancelKeyboard(AdminCallbacks.Chats),
        );
    }

    private async previewChat(ctx: Context, adminId: number, name: string, id: number): Promise<void> {
        if (!name.trim() || !Number.isSafeInteger(id) || id >= 0) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'Назва має бути непорожньою, а Telegram ID — коректним відʼємним цілим числом.',
                createFlowCancelKeyboard(AdminCallbacks.Chats),
            );
            return;
        }

        this.services.adminFlow.setData(adminId, { pendingChatName: name.trim(), pendingChatId: id });
        await this.services.adminUi.show(ctx, ['👀 Перевірте дані', '', `Назва: ${name.trim()}`, `Telegram ID: ${id}`, '', 'Усе правильно?'].join('\n'), createChatPreviewKeyboard());
    }

    private parseManualInput(text: string): { name: string; id: number } | undefined {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length !== 2) return undefined;
        const id = Number(lines[1]);
        if (!lines[0] || !Number.isSafeInteger(id) || id >= 0) return undefined;
        return { name: lines[0], id };
    }

    private getLegacyForwardChat(message: object): { id: number; title: string; type: string } | undefined {
        if (!('forward_from_chat' in message)) return undefined;
        const value = message.forward_from_chat;
        if (typeof value !== 'object' || value === null) return undefined;
        if (!('id' in value) || typeof value.id !== 'number' || !('title' in value) || typeof value.title !== 'string' || !('type' in value) || typeof value.type !== 'string') return undefined;
        return { id: value.id, title: value.title, type: value.type };
    }

    private async showManualInputRequired(ctx: Context): Promise<void> {
        await this.services.adminUi.replaceWithError(
            ctx,
            'Telegram приховав оригінальне джерело. Введіть назву та ID вручну:\n\nНазва чату\n-1001234567890',
            createFlowCancelKeyboard(AdminCallbacks.Chats),
        );
    }

    private async showChats(ctx: Context): Promise<void> {
        const chats = await this.services.chats.getAll();

        await this.services.adminUi.show(
            ctx,
            [
                '💬 Чати',
                '',
                chats.length > 0
                    ? `Збережено: ${chats.length}`
                    : 'Чатів поки немає.',
                '',
                chats.length > 0
                    ? 'Оберіть чат, щоб відкрити його.'
                    : 'Натисніть «Додати чат», щоб підключити першу групу.',
            ]
                .filter(
                    (line): line is string =>
                        line !== undefined,
                )
                .join('\n'),
            createChatsKeyboard(chats),
        );
    }

    private parseChatId(
        callback: string,
        prefix: string,
    ): number | undefined {
        const chatId = Number(
            callback.slice(prefix.length),
        );

        return Number.isSafeInteger(chatId)
            ? chatId
            : undefined;
    }
}
