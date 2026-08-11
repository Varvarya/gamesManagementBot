import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createAdminMainKeyboard(
    activeTrainingsCount: number,
    unconfirmedPlayersCount: number,
    setup?: { hasChats: boolean; hasTemplates: boolean },
    isSuperAdmin = false,
    setupRequired = false,
) {
    return Markup.inlineKeyboard([
        ...(setupRequired ? [[Markup.button.callback('▶️ Завершити налаштування', AdminCallbacks.Setup)]] : []),
        [
            Markup.button.callback(
                '📅 Розклад',
                AdminCallbacks.Schedule,
            ),
            Markup.button.callback(
                '🏸 Тренування',
                AdminCallbacks.ActiveTrainings,
            ),
        ],
        [
            Markup.button.callback(
                '👥 Гравці',
                AdminCallbacks.Players,
            ),
            Markup.button.callback(
                '💬 Чати',
                AdminCallbacks.Chats,
            ),
        ],
        [
            Markup.button.callback(
                '⚙️ Налаштування',
                AdminCallbacks.Settings,
            ),
        ],
        ...(isSuperAdmin ? [[Markup.button.callback('🌐 До суперадміністратора', 'mode:super')]] : []),
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
