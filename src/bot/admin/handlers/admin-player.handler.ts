import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { Player } from '../../../domain/players/player.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import {
    createPlayerKeyboard,
    createPlayerListKeyboard,
    createPlayersKeyboard,
} from '../keyboards/player.keyboard';

export class AdminPlayerHandler {
    constructor(
        private readonly services: ServicesContext,
    ) {}

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.Players ||
            callback ===
            AdminCallbacks.UnconfirmedPlayers ||
            callback === AdminCallbacks.AllPlayers ||
            callback.startsWith(
                AdminCallbacks.PlayerPrefix,
            )
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

        if (
            callback ===
            AdminCallbacks.UnconfirmedPlayers
        ) {
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

        await ctx.editMessageText(
            [
                '👥 Гравці',
                '',
                `⚠️ Очікують підтвердження: ${unconfirmed.length}`,
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

        await ctx.editMessageText(
            '⚠️ Непідтверджені гравці',
            createPlayerListKeyboard(players),
        );
    }

    private async showAll(
        ctx: Context,
    ): Promise<void> {
        const players =
            await this.services.repositories.players.list();

        players.sort((a, b) =>
            a.displayName.localeCompare(
                b.displayName,
                'uk',
            ),
        );

        await ctx.editMessageText(
            `👥 Всі гравці\n\nГравців: ${players.length}`,
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

        await ctx.editMessageText(
            this.render(player),
            createPlayerKeyboard(player),
        );
    }

    private render(player: Player): string {
        return [
            `${
                player.isConfirmed
                    ? '👤'
                    : '⚠️'
            } ${player.displayName}`,
            '',
            player.telegramName
                ? `Telegram name: ${player.telegramName}`
                : undefined,
            player.username
                ? `Telegram: @${player.username}`
                : undefined,
            '',
            player.isConfirmed
                ? '✅ Імʼя підтверджено'
                : '⚠️ Імʼя потрібно підтвердити',
        ]
            .filter(
                (value): value is string =>
                    value !== undefined,
            )
            .join('\n');
    }
}