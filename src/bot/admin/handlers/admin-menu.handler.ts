import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createAdminMainKeyboard, createMainMenuBackKeyboard } from '../keyboards/main.keyboard';

export class AdminMenuHandler {
    constructor(
        private readonly services: ServicesContext,
    ) {}

    canHandle(callback: string): boolean {
        return callback === AdminCallbacks.MainMenu || callback === AdminCallbacks.Help;
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (callback === AdminCallbacks.Help) {
            await this.showHelp(ctx);
        } else if (callback === AdminCallbacks.MainMenu) {
            await this.showMain(ctx);
        }
    }

    async showMain(ctx: Context): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        this.services.adminFlow.reset(adminId);

        const settings =
            await this.services.repositories.settings.get();

        const activeTrainings =
            await this.services.repositories.trainings.listActive();

        const unconfirmedPlayers =
            await this.services.repositories.players.listUnconfirmed();
        const chats = await this.services.chats.getAll();
        const templates = await this.services.repositories.templates.list();
        const setupLines = chats.length === 0
            ? ['🚀 Перший запуск', '1. Додайте груповий чат', '2. Створіть розклад', '3. Перевірте час публікації']
            : templates.length === 0
                ? ['🚀 Налаштування: 1 з 3', '✅ Чат додано', '2. Створіть розклад і виберіть чат', '3. Перевірте час публікації']
                : [];

        await this.services.adminUi.showRootMenu(
            ctx,
            [
                `🏸 ${settings.title}`,
                '',
                setupLines.length ? setupLines.join('\n') : 'Керування клубом',
                unconfirmedPlayers.length > 0
                    ? `⚠️ ${unconfirmedPlayers.length} гравців очікують підтвердження`
                    : undefined,
            ].filter((line): line is string => line !== undefined).join('\n'),
            createAdminMainKeyboard(
                activeTrainings.length,
                unconfirmedPlayers.length,
                { hasChats: chats.length > 0, hasTemplates: templates.length > 0 },
            ),
        );
    }

    private async showHelp(ctx: Context): Promise<void> {
        await this.services.adminUi.show(ctx, [
            '❓ Як користуватися ботом', '',
            '💬 Чати — додайте групу, де бот публікуватиме тренування.',
            '📅 Розклад — створіть шаблон, виберіть чат, дні та час.',
            '📣 Бот сам опублікує тренування у вибраний час.',
            '👤 Гравці записуються відповіддю +1. Після заповнення місць вони потрапляють до листа очікування.',
            '🏸 У тренуванні можна додати чи прибрати гравця, закрити запис або скасувати заняття.',
            '❌ Кнопка «Скасувати» завершує поточне налаштування без збереження.',
        ].join('\n'), createMainMenuBackKeyboard());
    }
}
