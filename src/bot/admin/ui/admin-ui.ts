import { Context, Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { logger } from '../../../utils/logger';
import { isTelegramMessageNotModified, isTelegramMessageUnavailable } from '../../../utils/telegramEditErrors';

export type AdminKeyboard =
    Markup.Markup<InlineKeyboardMarkup>;

type AdminUiSession = {
    chatId: number;
    userMessageIds: Set<number>;
    botMessageIds: Set<number>;
    rootMessageId?: number;
};

export class AdminUi {
    private readonly sessions = new Map<number, AdminUiSession>();
    private readonly trainingCards = new Map<string, Map<string, { telegram: Context['telegram']; chatId: number; messageId: number }>>();
    private trainingCardRenderer?: (trainingId: string) => Promise<{ text: string; keyboard?: AdminKeyboard }>;

    trackUserMessage(adminId: number, chatId: number, messageId: number): void {
        const session = this.getSession(adminId, chatId);
        if (session) session.userMessageIds.add(messageId);
    }

    trackBotMessage(adminId: number, chatId: number, messageId: number): void {
        const session = this.getSession(adminId, chatId);
        if (session) session.botMessageIds.add(messageId);
    }

    setRootMessage(adminId: number, chatId: number, messageId: number): void {
        const session = this.getSession(adminId, chatId);
        if (!session) return;
        session.botMessageIds.add(messageId);
        session.rootMessageId = messageId;
    }

    async show(
        ctx: Context,
        text: string,
        keyboard?: AdminKeyboard,
    ): Promise<number | undefined> {
        if (ctx.callbackQuery) {
            try {
                await ctx.editMessageText(text, keyboard);
            } catch (error) {
                if (!this.isIgnorableEditError(error)) {
                    logger.error('admin.message_edit_failed', { error });
                    throw error;
                }
            }
            this.trackContextBotMessage(ctx);
            return ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message?.message_id : undefined;
        }

        const message = await ctx.reply(
            text,
            keyboard,
        );
        this.trackReply(ctx, message);
        return this.getMessageId(message);
    }

    setTrainingCardRenderer(renderer: (trainingId: string) => Promise<{ text: string; keyboard?: AdminKeyboard }>): void {
        this.trainingCardRenderer = renderer;
    }

    async showTrainingCard(ctx: Context, trainingId: string, text: string, keyboard?: AdminKeyboard): Promise<void> {
        const messageId = await this.show(ctx, text, keyboard);
        if (!ctx.chat || messageId === undefined) return;
        const key = `${ctx.chat.id}:${messageId}`;
        const cards = this.trainingCards.get(trainingId) ?? new Map();
        cards.set(key, { telegram: ctx.telegram, chatId: ctx.chat.id, messageId });
        this.trainingCards.set(trainingId, cards);
    }

    async refreshTrainingCards(trainingId: string): Promise<void> {
        const cards = this.trainingCards.get(trainingId);
        if (!cards?.size || !this.trainingCardRenderer) return;
        const rendered = await this.trainingCardRenderer(trainingId);
        for (const [key, card] of cards) {
            try {
                await card.telegram.editMessageText(card.chatId, card.messageId, undefined, rendered.text, rendered.keyboard);
            } catch (error) {
                if (isTelegramMessageNotModified(error)) continue;
                if (isTelegramMessageUnavailable(error)) { cards.delete(key); continue; }
                logger.error('admin.training_card_refresh_failed', { trainingId, chatId: card.chatId, messageId: card.messageId, error });
            }
        }
        if (!cards.size) this.trainingCards.delete(trainingId);
    }

    async notice(
        ctx: Context,
        text: string,
    ): Promise<void> {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery(text);
            return;
        }

        const message = await ctx.reply(text);
        this.trackReply(ctx, message);
    }

    async replaceWithSuccess(
        ctx: Context,
        text: string,
        keyboard?: AdminKeyboard,
    ): Promise<void> {
        await this.show(
            ctx,
            [
                '✅ Готово',
                '',
                text,
            ].join('\n'),
            keyboard,
        );
    }

    async replaceWithError(
        ctx: Context,
        text: string,
        keyboard?: AdminKeyboard,
    ): Promise<void> {
        await this.show(
            ctx,
            [
                '❌ Помилка',
                '',
                text,
            ].join('\n'),
            keyboard,
        );
    }

    async cleanupForRootMenu(ctx: Context): Promise<number | undefined> {
        if (ctx.chat?.type !== 'private' || !ctx.from) return undefined;
        const adminId = ctx.from.id;
        const chatId = ctx.chat.id;
        const session = this.sessions.get(adminId);
        if (!session || session.chatId !== chatId) return undefined;

        const preservedRootId = session.rootMessageId;
        const targets = new Set<number>([
            ...session.userMessageIds,
            ...[...session.botMessageIds].filter((id) => id !== preservedRootId),
        ]);
        for (const messageId of targets) await this.deleteTracked(ctx, chatId, messageId);

        session.userMessageIds.clear();
        session.botMessageIds.clear();
        if (preservedRootId !== undefined) session.botMessageIds.add(preservedRootId);
        return preservedRootId;
    }

    async showRootMenu(ctx: Context, text: string, keyboard?: AdminKeyboard): Promise<void> {
        if (ctx.chat?.type !== 'private' || !ctx.from) {
            await this.show(ctx, text, keyboard);
            return;
        }

        if (ctx.message) this.trackUserMessage(ctx.from.id, ctx.chat.id, ctx.message.message_id);
        const preservedRootId = await this.cleanupForRootMenu(ctx);
        if (preservedRootId !== undefined) {
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, preservedRootId, undefined, text, keyboard);
                this.setRootMessage(ctx.from.id, ctx.chat.id, preservedRootId);
                return;
            } catch (error) {
                if (isTelegramMessageNotModified(error)) {
                    this.setRootMessage(ctx.from.id, ctx.chat.id, preservedRootId);
                    return;
                }
                await this.deleteTracked(ctx, ctx.chat.id, preservedRootId);
            }
        }

        const message = await ctx.reply(text, keyboard);
        const messageId = this.getMessageId(message);
        if (messageId !== undefined) this.setRootMessage(ctx.from.id, ctx.chat.id, messageId);
    }

    private getSession(adminId: number, chatId: number): AdminUiSession | undefined {
        if (!Number.isSafeInteger(chatId)) return undefined;
        const current = this.sessions.get(adminId);
        if (current?.chatId === chatId) return current;
        const session: AdminUiSession = { chatId, userMessageIds: new Set(), botMessageIds: new Set() };
        this.sessions.set(adminId, session);
        return session;
    }

    private trackReply(ctx: Context, message: unknown): void {
        if (ctx.chat?.type !== 'private' || !ctx.from) return;
        const messageId = this.getMessageId(message);
        if (messageId !== undefined) this.trackBotMessage(ctx.from.id, ctx.chat.id, messageId);
    }

    private trackContextBotMessage(ctx: Context): void {
        if (ctx.chat?.type !== 'private' || !ctx.from || !ctx.callbackQuery || !('message' in ctx.callbackQuery)) return;
        const messageId = ctx.callbackQuery.message?.message_id;
        if (messageId !== undefined) this.trackBotMessage(ctx.from.id, ctx.chat.id, messageId);
    }

    private getMessageId(message: unknown): number | undefined {
        if (!message || typeof message !== 'object' || !('message_id' in message)) return undefined;
        const value = (message as { message_id?: unknown }).message_id;
        return typeof value === 'number' ? value : undefined;
    }

    private async deleteTracked(ctx: Context, chatId: number, messageId: number): Promise<void> {
        try {
            await ctx.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
            if (this.isMissingMessage(error)) return;
            logger.warn('admin.ui_cleanup_failed', { chatId, messageId });
        }
    }

    private isMissingMessage(error: unknown): boolean {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        return message.includes('message to delete not found') || message.includes('message not found');
    }

    private isIgnorableEditError(error: unknown): boolean {
        return isTelegramMessageNotModified(error) || isTelegramMessageUnavailable(error);
    }
}
