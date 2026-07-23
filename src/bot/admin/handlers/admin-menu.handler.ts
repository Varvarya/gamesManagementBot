import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createAdminMainKeyboard } from '../keyboards/main.keyboard';

export class AdminMenuHandler {
    constructor(
        private readonly services: ServicesContext,
    ) {}

    canHandle(callback: string): boolean {
        return callback === AdminCallbacks.MainMenu;
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (callback === AdminCallbacks.MainMenu) {
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

        await this.services.adminUi.show(
            ctx,
            [
                `🏸 ${settings.title}`,
                '',
                'Панель керування клубом',
                '',
                activeTrainings.length > 0
                    ? `Найближчих тренувань: ${activeTrainings.length}`
                    : 'Активних тренувань зараз немає',
                unconfirmedPlayers.length > 0
                    ? `⚠️ ${unconfirmedPlayers.length} гравців очікують підтвердження`
                    : '✅ Усі імена гравців підтверджені',
            ].join('\n'),
            createAdminMainKeyboard(
                activeTrainings.length,
                unconfirmedPlayers.length,
            ),
        );
    }
}