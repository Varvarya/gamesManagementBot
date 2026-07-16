import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminSettingsHandler } from '../handlers/admin-settings.handler';

export class SettingsFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly settingsHandler: AdminSettingsHandler,
    ) {}

    canHandleText(
        adminId: number,
    ): boolean {
        return (
            this.services.adminFlow.getState(
                adminId,
            ) ===
            'waiting_cancel_check_hours'
        );
    }

    async handleText(
        ctx: Context,
        text: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        const hours = Number(text);

        if (
            !Number.isInteger(hours) ||
            hours < 0 ||
            hours > 168
        ) {
            await ctx.reply(
                [
                    '❌ Некоректне значення',
                    '',
                    'Введіть ціле число від 0 до 168',
                ].join('\n'),
            );

            return;
        }

        await this.settingsHandler.updateCancelCheckHours(
            hours,
        );

        this.services.adminFlow.reset(
            adminId,
        );

        await ctx.reply(
            [
                '✅ Налаштування оновлено',
                '',
                `Перевірка мінімуму відбуватиметься за ${hours} год до тренування`,
            ].join('\n'),
        );
    }
}