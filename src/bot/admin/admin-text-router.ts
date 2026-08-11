import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { logger } from '../../utils/logger';
import { ADMIN_FLOW_STATES, AdminFlowState } from './flows/admin-flow.types';
import { CallbackAuthorizationService, CallbackAccess } from '../authorization/callback-authorization.service';
import { SessionContextService } from '../session/session-context.service';

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

export type CallbackFlowStateProvider = {
    readonly callbackStates: readonly AdminFlowState[];
};

export class AdminTextRouter {
    constructor(
        private readonly services: ServicesContext,
        private readonly messageHandlers: readonly MessageFlowHandler[],
        private readonly textHandlers: readonly TextFlowHandler[],
        private readonly additionalAdminIds: readonly number[] = [],
        private readonly authorization?: CallbackAuthorizationService,
        private readonly activeClubId?: string,
        private readonly sessionContexts?: SessionContextService,
        private readonly callbackStateProviders: readonly CallbackFlowStateProvider[] = [],
    ) {
        this.validateStateCoverage();
    }

    async handle(ctx: Context): Promise<void> {
        if (ctx.chat?.type !== 'private' || !ctx.from || !ctx.message) return;
        const adminId = ctx.from.id;
        const state = this.services.adminFlow.getState(adminId);
        if (state === 'idle') return;
        const requiredAccess: CallbackAccess = state === 'waiting_config_import' ? 'super_admin' : 'club_admin';
        const activeClubId = this.sessionContexts?.get(adminId)?.activeClubId ?? this.activeClubId;
        if (requiredAccess === 'club_admin' && activeClubId !== this.services.repositories.clubId) {
            const settingsClubId = (await this.services.repositories.settings.get()).clubId;
            logger.error('club.context_mismatch', {
                sessionClubId: activeClubId,
                repositoryClubId: this.services.repositories.clubId,
                settingsClubId,
                action: `flow:${state}`,
            });
            await ctx.reply('⚠️ Контекст клубу змінився. Відкрийте меню клубу знову.');
            return;
        }
        const allowed = this.authorization
            ? await this.authorization.canAccessCallback({ telegramUserId: adminId, callback: `flow:${state}`, activeClubId, requiredAccess })
            : true;
        if (!allowed) {
            logger.warn('telegram.message_access_denied', { telegramUserId: adminId, state, requiredAccess, activeClubId });
            await ctx.reply('⛔ У вас немає доступу до цієї дії.');
            return;
        }
        this.services.adminUi.trackUserMessage(adminId, ctx.chat.id, ctx.message.message_id);

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

        logger.warn('admin.flow.unhandled', {
            adminId,
            state,
            messageType: getMessageType(ctx),
        });
        if (!('text' in ctx.message) && this.isTextState(state)) {
            await this.services.adminUi.notice(ctx, 'На цьому кроці потрібне текстове повідомлення. Надішліть текст або натисніть «Скасувати».');
        }
    }

    private validateStateCoverage(): void {
        const covered = new Set<AdminFlowState>(['idle']);
        for (const handler of this.messageHandlers) for (const state of handler.messageStates) covered.add(state);
        for (const handler of this.textHandlers) {
            for (const state of handler.textStates) covered.add(state);
            for (const state of handler.callbackStates ?? []) covered.add(state);
        }
        for (const provider of this.callbackStateProviders) {
            for (const state of provider.callbackStates) covered.add(state);
        }
        const orphaned = ADMIN_FLOW_STATES.filter((state) => !covered.has(state));
        if (orphaned.length) throw new Error(`Orphaned admin flow states: ${orphaned.join(', ')}`);
    }

    private isTextState(state: AdminFlowState): boolean {
        return this.textHandlers.some((handler) => handler.textStates.includes(state));
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
