import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { logger } from '../../utils/logger';
import { ADMIN_FLOW_STATES, AdminFlowState } from './flows/admin-flow.types';

export type MessageFlowHandler = {
    readonly messageStates: readonly AdminFlowState[];
    canHandleMessage(adminId: number): boolean;
    handleMessage(ctx: Context): Promise<boolean>;
};

export type TextFlowHandler = {
    readonly textStates: readonly AdminFlowState[];
    readonly callbackStates?: readonly AdminFlowState[];
    canHandleText(adminId: number): boolean;
    handleText(ctx: Context, text: string): Promise<void>;
};

export class AdminTextRouter {
    constructor(
        private readonly services: ServicesContext,
        private readonly messageHandlers: readonly MessageFlowHandler[],
        private readonly textHandlers: readonly TextFlowHandler[],
        private readonly additionalAdminIds: readonly number[] = [],
    ) {
        this.validateStateCoverage();
    }

    async handle(ctx: Context): Promise<void> {
        if (ctx.chat?.type !== 'private' || !ctx.from || !ctx.message) return;
        if (!(await this.isAdmin(ctx.from.id)) && !this.additionalAdminIds.includes(ctx.from.id)) return;

        const adminId = ctx.from.id;
        const state = this.services.adminFlow.getState(adminId);
        if (state !== 'idle') {
            this.services.adminUi.trackUserMessage(adminId, ctx.chat.id, ctx.message.message_id);
        }

        for (const handler of this.messageHandlers) {
            if (!handler.canHandleMessage(adminId)) continue;
            const handled = await handler.handleMessage(ctx);
            if (handled) return;
        }

        if ('text' in ctx.message) {
            const text = ctx.message.text.trim();
            for (const handler of this.textHandlers) {
                if (!handler.canHandleText(adminId)) continue;
                await handler.handleText(ctx, text);
                return;
            }
        }

        if (state !== 'idle') {
            logger.warn('admin.flow.unhandled', {
                adminId,
                state,
                messageType: getMessageType(ctx),
            });
            if (!('text' in ctx.message) && this.isTextState(state)) {
                await this.services.adminUi.notice(ctx, 'На цьому кроці потрібне текстове повідомлення. Надішліть текст або натисніть «Скасувати».');
            }
        }
    }

    private validateStateCoverage(): void {
        const covered = new Set<AdminFlowState>(['idle']);
        for (const handler of this.messageHandlers) for (const state of handler.messageStates) covered.add(state);
        for (const handler of this.textHandlers) {
            for (const state of handler.textStates) covered.add(state);
            for (const state of handler.callbackStates ?? []) covered.add(state);
        }
        const orphaned = ADMIN_FLOW_STATES.filter((state) => !covered.has(state));
        if (orphaned.length) throw new Error(`Orphaned admin flow states: ${orphaned.join(', ')}`);
    }

    private isTextState(state: AdminFlowState): boolean {
        return this.textHandlers.some((handler) => handler.textStates.includes(state));
    }

    private async isAdmin(telegramUserId: number): Promise<boolean> {
        const settings = await this.services.repositories.settings.get();
        return settings.admins.some((admin) => admin.telegramUserId === telegramUserId);
    }
}

function getMessageType(ctx: Context): string {
    const message = ctx.message;
    if (!message) return 'unknown';
    for (const type of ['text', 'document', 'contact', 'photo', 'video', 'audio', 'voice', 'sticker', 'location', 'forward_origin'] as const) {
        if (type in message) return type;
    }
    return 'other';
}
