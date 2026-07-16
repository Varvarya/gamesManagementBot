import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createAdminMainKeyboard(
    activeTrainingsCount: number,
    unconfirmedPlayersCount: number,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '📅 Розклад',
                AdminCallbacks.Schedule,
            ),
            Markup.button.callback(
                `🏸 Тренування${
                    activeTrainingsCount > 0
                        ? ` · ${activeTrainingsCount}`
                        : ''
                }`,
                AdminCallbacks.ActiveTrainings,
            ),
        ],
        [
            Markup.button.callback(
                `👥 Гравці${
                    unconfirmedPlayersCount > 0
                        ? ` · ⚠️ ${unconfirmedPlayersCount}`
                        : ''
                }`,
                AdminCallbacks.Players,
            ),
            Markup.button.callback(
                '⚙️ Налаштування',
                AdminCallbacks.Settings,
            ),
        ],
    ]);
}

export function createMainMenuBackKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '🏠 Головне меню',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}