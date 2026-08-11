import { Context, Markup } from 'telegraf';
import { logger } from '../../utils/logger';

import { ServicesContext } from '../../app/services.context';

import { PlayerFlowHandler } from './flows/player-flow.handler';
import { TemplateFlowHandler } from './flows/template-flow.handler';
import { TrainingFlowHandler } from './flows/training-flow.handler';

import { AdminMenuHandler } from './handlers/admin-menu.handler';
import { AdminPlayerHandler } from './handlers/admin-player.handler';
import { AdminSettingsHandler } from './handlers/admin-settings.handler';
import { AdminTemplateHandler } from './handlers/admin-template.handler';
import { AdminTrainingHandler } from './handlers/admin-training.handler';
import { AdminChatHandler } from './handlers/admin-chat.handler';
import { CallbackAuthorizationService } from '../authorization/callback-authorization.service';
import { SessionContextService } from '../session/session-context.service';
import { SessionMode } from '../session/session-context.service';
import { AdminNavigationService } from '../navigation/admin-navigation.service';
import { AdminCallbacks } from './callbacks/admin-callbacks';

export type CallbackHandler = {
    canHandle(callback: string): boolean;

    handle(
        ctx: Context,
        callback: string,
    ): Promise<void>;
};

export type FlowCallbackHandler = {
    canHandleCallback(
        callback: string,
    ): boolean;

    handleCallback(
        ctx: Context,
        callback: string,
    ): Promise<void>;
};

export type AnyHandler =
    | CallbackHandler
    | FlowCallbackHandler;

export class AdminCallbackRouter {
    private readonly handlers: AnyHandler[];
    private readonly handledUpdates = new Set<number>();

    constructor(
        private readonly services: ServicesContext,
        private readonly authorization: CallbackAuthorizationService,
        private readonly activeClubId: string,
        private readonly sessionContexts: SessionContextService,
        private readonly navigation: AdminNavigationService,

        templateFlow: TemplateFlowHandler,
        playerFlow: PlayerFlowHandler,
        trainingFlow: TrainingFlowHandler,

        menuHandler: AdminMenuHandler,
        trainingHandler: AdminTrainingHandler,
        playerHandler: AdminPlayerHandler,
        templateHandler: AdminTemplateHandler,
        chatHandler: AdminChatHandler,
        settingsHandler: AdminSettingsHandler,
    ) {
        this.handlers = [
            // Flow handlers
            templateFlow,
            playerFlow,
            trainingFlow,

            // Regular handlers
            menuHandler,
            trainingHandler,
            playerHandler,
            templateHandler,
            chatHandler,
            settingsHandler,
        ];
    }

    async handle(
        ctx: Context,
    ): Promise<void> {
        if (
            ctx.chat?.type !== 'private' ||
            !ctx.from ||
            !ctx.callbackQuery ||
            !('data' in ctx.callbackQuery)
        ) {
            return;
        }

        let callback = ctx.callbackQuery.data;
        const session = this.sessionContexts.get(ctx.from.id);
        if (session?.mode !== SessionMode.CLUB_ADMIN || !session.activeClubId) {
            await ctx.answerCbQuery('⚠️ Це меню вже неактивне.');
            return;
        }
        if (session.activeClubId !== this.services.repositories.clubId) {
            const settingsClubId = (await this.services.repositories.settings.get()).clubId;
            logger.error('club.context_mismatch', {
                sessionClubId: session.activeClubId,
                repositoryClubId: this.services.repositories.clubId,
                settingsClubId,
                action: callback,
            });
            await ctx.answerCbQuery('⚠️ Контекст клубу змінився. Перезапустіть меню.', { show_alert: true });
            return;
        }
        if (callback === AdminCallbacks.Back) {
            this.services.adminFlow.finish(ctx.from.id);
            callback = this.navigation.backScreen(ctx.from.id);
        }
        const handler = findCallbackHandler(this.handlers, callback);

        if (!handler) {
            logger.warn('telegram.admin_callback_unhandled', { callback });
            await ctx.editMessageText('⚠️ Це меню вже неактивне.', Markup.inlineKeyboard([
                [Markup.button.callback('🏠 Меню клубу', AdminCallbacks.MainMenu)],
            ])).catch(() => ctx.answerCbQuery('⚠️ Це меню вже неактивне.', { show_alert: true }));
            return;
        }

        const requiredAccess = this.authorization.requiredAccess(callback);
        const activeClubId = this.sessionContexts?.get(ctx.from.id)?.activeClubId ?? this.activeClubId;
        if (!await this.authorization.canAccessCallback({ telegramUserId: ctx.from.id, callback, activeClubId, requiredAccess })) {
            logger.warn('telegram.callback_access_denied', { telegramUserId: ctx.from.id, callback, requiredAccess, activeClubId, matchedHandler: handler.constructor.name });
            try { await ctx.answerCbQuery('⛔ У вас немає доступу до цієї дії.', { show_alert: true }); }
            catch { await ctx.reply('⛔ У вас немає доступу до цієї дії.'); }
            return;
        }
        if (callback === AdminCallbacks.MainMenu) this.navigation.resetToRoot(ctx.from.id);
        else if (isNavigableScreen(callback) && this.sessionContexts.get(ctx.from.id)?.navigationStack.at(-1)?.screen !== callback) this.navigation.navigate(ctx.from.id, callback);
        const updateId = ctx.update.update_id;
        if (this.handledUpdates.has(updateId)) return;
        this.handledUpdates.add(updateId);
        if (this.handledUpdates.size > 10_000) this.handledUpdates.delete(this.handledUpdates.values().next().value!);

        try {
            await ctx.answerCbQuery();
        } catch {
            // Callback may already be expired.
        }

        if ('handleCallback' in handler) await handler.handleCallback(ctx, callback);
        else await handler.handle(ctx, callback);
        if (callback === 'cfg' || callback.startsWith('cfg:')) await this.authorization.recordMeaningfulActivity(activeClubId);
    }

    /** Used by routing contract tests to ensure generated buttons are registered. */
    canDispatchCallback(callback: string): boolean {
        return findCallbackHandler(this.handlers, callback) !== undefined;
    }
}

function isNavigableScreen(callback: string): boolean {
    return ['s', 'tr:a', 'tr:r', 'p', 'p:u', 'p:a', 'p:k', 'p:i', 'c', 'cfg', 'cfg:a', 'cfg:st'].includes(callback)
        || /^(?:tr:v:|tr:ra:|p:v:|c:v:|t:v:)/.test(callback);
}

export function findCallbackHandler(
    handlers: readonly AnyHandler[],
    callback: string,
): AnyHandler | undefined {
    if (callback === AdminCallbacks.Back) return NAVIGATION_BACK_HANDLER;
    return handlers.find((candidate) => 'canHandleCallback' in candidate
        ? candidate.canHandleCallback(callback)
        : candidate.canHandle(callback));
}

const NAVIGATION_BACK_HANDLER: CallbackHandler = { canHandle: (callback) => callback === AdminCallbacks.Back, handle: async () => undefined };
