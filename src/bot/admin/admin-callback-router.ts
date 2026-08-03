import { Context } from 'telegraf';
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

type CallbackHandler = {
    canHandle(callback: string): boolean;

    handle(
        ctx: Context,
        callback: string,
    ): Promise<void>;
};

type FlowCallbackHandler = {
    canHandleCallback(
        callback: string,
    ): boolean;

    handleCallback(
        ctx: Context,
        callback: string,
    ): Promise<void>;
};

type AnyHandler =
    | CallbackHandler
    | FlowCallbackHandler;

export class AdminCallbackRouter {
    private readonly handlers: AnyHandler[];
    private readonly handledUpdates = new Set<number>();

    constructor(
        private readonly services: ServicesContext,

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

        if (
            !(await this.isAdmin(ctx.from.id))
        ) {
            return;
        }

        const callback =
            ctx.callbackQuery.data;
        const updateId = ctx.update.update_id;
        if (this.handledUpdates.has(updateId)) return;
        this.handledUpdates.add(updateId);
        if (this.handledUpdates.size > 10_000) this.handledUpdates.delete(this.handledUpdates.values().next().value!);

        try {
            await ctx.answerCbQuery();
        } catch {
            // Callback may already be expired.
        }

        for (const handler of this.handlers) {
            const canHandle =
                'canHandleCallback' in handler
                    ? handler.canHandleCallback(
                        callback,
                    )
                    : handler.canHandle(
                        callback,
                    );

            if (!canHandle) {
                continue;
            }

            if (
                'handleCallback' in handler
            ) {
                await handler.handleCallback(
                    ctx,
                    callback,
                );
            } else {
                await handler.handle(
                    ctx,
                    callback,
                );
            }

            return;
        }

        logger.warn('telegram.admin_callback_unhandled', { callback });
        await this.services.adminUi.notice(ctx, 'Ця кнопка вже неактуальна. Відкрийте головне меню командою /start.');
    }

    private async isAdmin(
        telegramUserId: number,
    ): Promise<boolean> {
        const superAdmins =
            process.env.SUPER_ADMIN_IDS
                ?.split(',')
                .map(Number)
            ?? [];

        if (superAdmins.includes(telegramUserId)) {
            return true;
        }

        const settings =
            await this.services.repositories.settings.get();

        return settings.admins.some(
            admin =>
                admin.telegramUserId === telegramUserId,
        );
    }
}
