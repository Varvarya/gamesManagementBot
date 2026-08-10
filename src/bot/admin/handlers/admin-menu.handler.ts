import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createAdminMainKeyboard, createMainMenuBackKeyboard } from '../keyboards/main.keyboard';
import { SessionContextService } from '../../session/session-context.service';
import { logger } from '../../../utils/logger';
import { isTelegramUserClubAdmin } from '../../../domain/settings/club-admin-authorization';

export class AdminMenuHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly superAdminIds: readonly number[] = [],
        private readonly sessions?: SessionContextService,
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
        const session = this.sessions?.get(adminId);
        const debug = { telegramUserId: adminId, action: 'club_menu_opened', mode: session?.mode, activeClubId: session?.activeClubId, repositoryClubId: this.services.repositories.clubId, settingsClubId: settings.clubId, adminEntries: settings.admins, isClubAdmin: isTelegramUserClubAdmin(settings.admins, adminId), flowState: this.services.adminFlow.getState(adminId) };
        if (session?.activeClubId && (session.activeClubId !== this.services.repositories.clubId || session.activeClubId !== settings.clubId)) logger.error('admin.session_debug', debug); else logger.info('admin.session_debug', debug);

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
                `🏸 ${this.sessions?.get(adminId)?.activeClubName ?? settings.title}`,
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
                this.superAdminIds.includes(adminId),
            ),
        );
    }

    private async showHelp(ctx: Context): Promise<void> {
        await this.services.adminUi.show(ctx, [
            '❓ Як користуватися ботом', '',
            '💬 Чати — додайте групу, де бот публікуватиме тренування.',
            '📅 Розклад — створіть шаблон, виберіть чат, дні та час.',
            '📣 Бот сам опублікує тренування у вибраний час.',
            '👤 Гравці записуються командами +1…+4. Для гостя: +2 Іван. Якщо місць недостатньо, реєстрація потрапляє до листа очікування.',
            '🏸 У тренуванні можна додати чи прибрати гравця, закрити запис або скасувати заняття.',
            '❌ Кнопка «Скасувати» завершує поточне налаштування без збереження.',
        ].join('\n'), createMainMenuBackKeyboard());
    }
}
