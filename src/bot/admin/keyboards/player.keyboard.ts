import { Markup } from 'telegraf';
import { Player } from '../../../domain/players/player.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createPlayersKeyboard(
    unconfirmedCount: number,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                `⚠️ Непідтверджені (${unconfirmedCount})`,
                AdminCallbacks.UnconfirmedPlayers,
            ),
        ],
        [
            Markup.button.callback(
                '👥 Всі гравці',
                AdminCallbacks.AllPlayers,
            ),
        ],
        [
            Markup.button.callback(
                '➕ Додати гравця',
                AdminCallbacks.CreatePlayer,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createPlayerListKeyboard(
    players: Player[],
) {
    return Markup.inlineKeyboard([
        ...players.map((player) => [
            Markup.button.callback(
                `${
                    player.isConfirmed
                        ? '👤'
                        : '⚠️'
                } ${player.displayName}`,
                `${AdminCallbacks.PlayerPrefix}${player.id}`,
            ),
        ]),
        [
            Markup.button.callback(
                '◀️ До гравців',
                AdminCallbacks.Players,
            ),
        ],
    ]);
}

export function createPlayerKeyboard(
    player: Player,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '✏️ Змінити імʼя',
                `${AdminCallbacks.PlayerPrefix}${player.id}:rename`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ До гравців',
                AdminCallbacks.Players,
            ),
        ],
    ]);
}