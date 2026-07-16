import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { PlayerFlowHandler } from './flows/player-flow.handler';
import { TemplateFlowHandler } from './flows/template-flow.handler';
import { TrainingFlowHandler } from './flows/training-flow.handler';
import { SettingsFlowHandler } from './flows/settings-flow.handler';

type TextFlowHandler = {
    canHandleText(
        adminId: number,
    ): boolean;

    handleText(
        ctx: Context,
        text: string,
    ): Promise<void>;
};

export class AdminTextRouter {
    private readonly handlers: TextFlowHandler[];

    constructor(
        private readonly services: ServicesContext,

        templateFlow: TemplateFlowHandler,
        playerFlow: PlayerFlowHandler,
        trainingFlow: TrainingFlowHandler,
        settingsFlow: SettingsFlowHandler,
    ) {
        this.handlers = [
            templateFlow,
            playerFlow,
            trainingFlow,
            settingsFlow,
        ];
    }

    async handle(
        ctx: Context,
    ): Promise<void> {
        if (
            ctx.chat?.type !== 'private' ||
            !ctx.from ||
            !ctx.message ||
            !('text' in ctx.message)
        ) {
            return;
        }

        if (
            !(await this.isAdmin(ctx.from.id))
        ) {
            return;
        }

        const adminId = ctx.from.id;
        const text = ctx.message.text.trim();

        for (const handler of this.handlers) {
            if (
                !handler.canHandleText(
                    adminId,
                )
            ) {
                continue;
            }

            await handler.handleText(
                ctx,
                text,
            );

            return;
        }
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