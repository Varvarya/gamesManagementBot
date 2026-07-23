import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { createSettingsKeyboard } from '../keyboards/settings.keyboard';

export class AdminSettingsHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly cancellationScheduler: TrainingCancellationScheduler,
    ) {}

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.Settings ||
            callback ===
            AdminCallbacks.SettingsCancelHours ||
            callback ===
            AdminCallbacks.SettingsToggleCleanChat
        );
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        if (
            callback ===
            AdminCallbacks.SettingsCancelHours
        ) {
            this.services.adminFlow.transition(
                adminId,
                'waiting_cancel_check_hours',
            );

            await this.services.adminUi.show(
                ctx,
                [
                    '⏰ Перевірка мінімуму',
                    '',
                    'Надішліть кількість годин до початку тренування',
                    '',
                    'Наприклад: 4',
                    'Доступний діапазон: 0–168',
                ].join('\n'),
                createFlowCancelKeyboard(
                    AdminCallbacks.Settings,
                ),
            );
            return;
        }

        if (
            callback ===
            AdminCallbacks.SettingsToggleCleanChat
        ) {
            await this.toggleCleanChat(ctx);
            return;
        }

        await this.show(ctx);
    }

    async show(ctx: Context): Promise<void> {
        const settings =
            await this.services.repositories.settings.get();

        await this.services.adminUi.show(
            ctx,
            [
                '⚙️ Налаштування клубу',
                '',
                `🏸 ${settings.title}`,
                `🌍 ${settings.timezone}`,
                '',
                `⏰ Перевірка мінімуму: за ${settings.cancelCheckHoursBefore} год`,
                `🧹 Видаляти повідомлення +1/-1: ${
                    settings.cleanChatMode
                        ? 'увімкнено'
                        : 'вимкнено'
                }`,
            ].join('\n'),
            createSettingsKeyboard(
                settings.cleanChatMode,
            ),
        );
    }

    async updateCancelCheckHours(
        hours: number,
    ): Promise<void> {
        const settings =
            await this.services.repositories.settings.get();

        settings.cancelCheckHoursBefore = hours;
        settings.updatedAt =
            new Date().toISOString();

        await this.services.repositories.settings.save(
            settings,
        );

        await this.cancellationScheduler.restore();
    }

    private async toggleCleanChat(
        ctx: Context,
    ): Promise<void> {
        const settings =
            await this.services.repositories.settings.get();

        settings.cleanChatMode =
            !settings.cleanChatMode;

        settings.updatedAt =
            new Date().toISOString();

        await this.services.repositories.settings.save(
            settings,
        );

        await this.show(ctx);
    }
}