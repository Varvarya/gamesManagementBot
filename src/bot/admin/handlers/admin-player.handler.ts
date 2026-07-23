import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import {
    createPlayerKeyboard,
    createPlayerListKeyboard,
    createPlayersKeyboard,
} from '../keyboards/player.keyboard';
import { renderPlayerCard } from '../ui/admin-formatters';

export class AdminPlayerHandler {
    constructor(
        private readonly services: ServicesContext,
    ) {}

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.Players ||
            callback === AdminCallbacks.UnconfirmedPlayers ||
            callback === AdminCallbacks.AllPlayers ||
            callback.startsWith(AdminCallbacks.PlayerPrefix)
        );
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (callback === AdminCallbacks.Players) {
            await this.showPlayers(ctx);
            return;
        }

        if (callback === AdminCallbacks.UnconfirmedPlayers) {
            await this.showUnconfirmed(ctx);
            return;
        }

        if (callback === AdminCallbacks.AllPlayers) {
            await this.showAll(ctx);
            return;
        }

        await this.showPlayer(
            ctx,
            callback.replace(
                AdminCallbacks.PlayerPrefix,
                '',
            ),
        );
    }

    private async showPlayers(
        ctx: Context,
    ): Promise<void> {
        const unconfirmed =
            await this.services.repositories.players.listUnconfirmed();

        await this.services.adminUi.show(
            ctx,
            [
                '👥 Гравці',
                '',
                unconfirmed.length > 0
                    ? `⚠️ Очікують підтвердження: ${unconfirmed.length}`
                    : '✅ Усі імена підтверджені',
                '',
                'Оберіть потрібний розділ',
            ].join('\n'),
            createPlayersKeyboard(
                unconfirmed.length,
            ),
        );
    }

    private async showUnconfirmed(
        ctx: Context,
    ): Promise<void> {
        const players =
            await this.services.repositories.players.listUnconfirmed();

        await this.services.adminUi.show(
            ctx,
            [
                '⚠️ Непідтверджені гравці',
                '',
                players.length > 0
                    ? 'Оберіть гравця, щоб підтвердити або змінити імʼя'
                    : 'Усі гравці вже підтверджені',
            ].join('\n'),
            createPlayerListKeyboard(players),
        );
    }

    private async showAll(
        ctx: Context,
    ): Promise<void> {
        const players =
            await this.services.repositories.players.list();

        players.sort((first, second) =>
            first.displayName.localeCompare(
                second.displayName,
                'uk',
            ),
        );

        await this.services.adminUi.show(
            ctx,
            [
                '👥 Усі гравці',
                '',
                `Всього: ${players.length}`,
                '',
                players.length > 0
                    ? 'Оберіть гравця'
                    : 'Список поки порожній',
            ].join('\n'),
            createPlayerListKeyboard(players),
        );
    }

    private async showPlayer(
        ctx: Context,
        playerId: string,
    ): Promise<void> {
        const player =
            await this.services.repositories.players.findById(
                playerId,
            );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        await this.services.adminUi.show(
            ctx,
            renderPlayerCard(player),
            createPlayerKeyboard(player),
        );
    }
}