import { Context } from 'telegraf';

import { logger } from '../../utils/logger';

type PromptKey = string;
type TrackedMessage = { chatId: number; messageId: number; timer?: ReturnType<typeof setTimeout> };

export class RegistrationMessageCleanup {
    private readonly prompts = new Map<PromptKey, TrackedMessage>();

    constructor(
        private readonly warningTtlMs = 6_000,
        private readonly promptTtlMs = 7 * 60_000,
    ) {}

    async sendTemporary(ctx: Context, text: string): Promise<void> {
        const message = await ctx.reply(text);
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const timer = setTimeout(() => {
            void this.deleteMessage(ctx, chatId, messageId, 'ttl');
        }, this.warningTtlMs);
        timer.unref?.();
        logger.debug('registration.temporary_message_scheduled', { chatId, messageId, ttlMs: this.warningTtlMs });
    }

    async trackPrompt(ctx: Context, clubId: string, chatId: number, telegramUserId: number, messageId: number): Promise<void> {
        const key = this.promptKey(clubId, chatId, telegramUserId);
        const previous = this.prompts.get(key);
        if (previous) {
            await this.deleteTracked(ctx, key, previous, 'replaced');
            logger.debug('registration.temporary_message_replaced', { chatId, telegramUserId, previousMessageId: previous.messageId, messageId });
        }
        const tracked: TrackedMessage = { chatId, messageId };
        tracked.timer = setTimeout(() => {
            if (this.prompts.get(key) !== tracked) return;
            void this.deleteTracked(ctx, key, tracked, 'expired');
        }, this.promptTtlMs);
        tracked.timer.unref?.();
        this.prompts.set(key, tracked);
    }

    async deletePrompt(ctx: Context, clubId: string, chatId: number, telegramUserId: number): Promise<void> {
        const key = this.promptKey(clubId, chatId, telegramUserId);
        const tracked = this.prompts.get(key);
        if (tracked) await this.deleteTracked(ctx, key, tracked, 'completed');
    }

    private async deleteTracked(ctx: Context, key: PromptKey, tracked: TrackedMessage, reason: string): Promise<void> {
        if (this.prompts.get(key) === tracked) this.prompts.delete(key);
        if (tracked.timer) clearTimeout(tracked.timer);
        await this.deleteMessage(ctx, tracked.chatId, tracked.messageId, reason);
    }

    private async deleteMessage(ctx: Context, chatId: number, messageId: number, reason: string): Promise<void> {
        try {
            await ctx.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
            logger.warn('registration.temporary_message_delete_failed', { chatId, messageId, reason, error });
        }
    }

    private promptKey(clubId: string, chatId: number, telegramUserId: number): PromptKey {
        return `${clubId}:${chatId}:${telegramUserId}`;
    }
}
