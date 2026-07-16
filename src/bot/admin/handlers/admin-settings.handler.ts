import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
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

            await ctx.editMessageText(
                [
                    '⏰ Перевірка мінімуму гравців',
                    '',
                    'Введіть, за скільки годин до тренування перевіряти кількість записаних',
                    '',
                    'Наприклад: 4',
                    '',
                    'Введіть 0, щоб перевіряти в момент початку тренування',
                ].join('\n'),
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

        await ctx.editMessageText(
            [
                '⚙️ Налаштування',
                '',
                `🏸 Клуб: ${settings.title}`,
                `🌍 Часовий пояс: ${settings.timezone}`,
                `💬 Chat ID: ${settings.chatId ?? 'не вказано'}`,
                '',
                `⏰ Перевірка мінімуму: за ${settings.cancelCheckHoursBefore} год`,
                `🧹 Видаляти +1/-1: ${
                    settings.cleanChatMode
                        ? 'так'
                        : 'ні'
                }`,
            ].join('\n'),
            createSettingsKeyboard(
                settings.cleanChatMode,
            ),
        );
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

    async updateCancelCheckHours(
        hours: number,
    ): Promise<void> {
        const settings =
            await this.services.repositories.settings.get();

        settings.cancelCheckHoursBefore =
            hours;

        settings.updatedAt =
            new Date().toISOString();

        await this.services.repositories.settings.save(
            settings,
        );

        await this.cancellationScheduler.restore();
    }
}