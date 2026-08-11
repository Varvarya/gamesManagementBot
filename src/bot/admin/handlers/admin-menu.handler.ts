import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createAdminMainKeyboard, createMainMenuBackKeyboard } from '../keyboards/main.keyboard';
import { SessionContextService } from '../../session/session-context.service';
import { logger } from '../../../utils/logger';
import { isTelegramUserClubAdmin } from '../../../domain/settings/club-admin-authorization';
import { createSetupOverviewKeyboard } from '../keyboards/setup.keyboard';

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

        const chats = await this.services.chats.getAll();
        const hasActiveChat = chats.some((chat) => chat.enabled);
        const readiness = await this.services.readiness.calculate();
        if (!readiness.ready && !session?.setupIntroSeen) {
            this.sessions?.markSetupIntroSeen(adminId);
            const mark = (done: boolean) => done ? '✅' : '⬜';
            await this.services.adminUi.showRootMenu(ctx, [`🏸 ${this.sessions?.get(adminId)?.activeClubName ?? settings.title}`, '', 'Налаштуємо клуб для роботи.', '',
                `${mark(readiness.identityConfigured)} Клуб створено`, `${mark(readiness.ownerConfigured)} Адміністратор`, `${mark(readiness.chatConfigured)} Чат`,
                `${mark(readiness.scheduleConfigured)} Розклад`, `${mark(readiness.publicationConfigured)} Публікація`].join('\n'), createSetupOverviewKeyboard(false));
            return;
        }

        await this.services.adminUi.showRootMenu(
            ctx,
            [
                `🏸 ${this.sessions?.get(adminId)?.activeClubName ?? settings.title}`,
                !readiness.ready ? `\n⚠️ Завершіть налаштування:\n${readiness.warnings.map((warning) => `• ${warning.message}`).join('\n')}` : undefined,
            ].filter((line): line is string => line !== undefined).join('\n'),
            createAdminMainKeyboard(
                0,
                0,
                { hasChats: chats.length > 0, hasTemplates: true },
                this.superAdminIds.includes(adminId),
                !readiness.ready,
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
