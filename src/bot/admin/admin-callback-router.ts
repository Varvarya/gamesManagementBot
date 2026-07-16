import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { PlayerFlowHandler } from './flows/player-flow.handler';
import { TemplateFlowHandler } from './flows/template-flow.handler';
import { TrainingFlowHandler } from './flows/training-flow.handler';
import { AdminMenuHandler } from './handlers/admin-menu.handler';
import { AdminPlayerHandler } from './handlers/admin-player.handler';
import { AdminSettingsHandler } from './handlers/admin-settings.handler';
import { AdminTemplateHandler } from './handlers/admin-template.handler';
import { AdminTrainingHandler } from './handlers/admin-training.handler';

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

export class AdminCallbackRouter {
    private readonly handlers: Array<
        CallbackHandler | FlowCallbackHandler
    >;

    constructor(
        private readonly services: ServicesContext,

        templateFlow: TemplateFlowHandler,
        playerFlow: PlayerFlowHandler,
        trainingFlow: TrainingFlowHandler,

        menuHandler: AdminMenuHandler,
        trainingHandler: AdminTrainingHandler,
        playerHandler: AdminPlayerHandler,
        templateHandler: AdminTemplateHandler,
        settingsHandler: AdminSettingsHandler,
    ) {
        this.handlers = [
            templateFlow,
            playerFlow,
            trainingFlow,

            menuHandler,
            trainingHandler,
            playerHandler,
            templateHandler,
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

            await ctx.answerCbQuery();

            if ('handleCallback' in handler) {
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

        console.warn(
            `Unhandled admin callback: ${callback}`,
        );
    }

    private async isAdmin(
        telegramUserId: number,
    ): Promise<boolean> {
        const settings =
            await this.services.repositories.settings.get();

        return settings.admins.some(
            (admin) =>
                admin.telegramUserId ===
                telegramUserId,
        );
    }
}