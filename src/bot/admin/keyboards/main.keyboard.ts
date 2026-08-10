import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createAdminMainKeyboard(
    activeTrainingsCount: number,
    unconfirmedPlayersCount: number,
    setup?: { hasChats: boolean; hasTemplates: boolean },
    isSuperAdmin = false,
) {
    return Markup.inlineKeyboard([
        ...(!setup?.hasChats ? [[Markup.button.callback('1️⃣ Додати перший чат', AdminCallbacks.AddChat)]] : []),
        ...(setup?.hasChats && !setup.hasTemplates ? [[Markup.button.callback('2️⃣ Створити розклад', AdminCallbacks.CreateTemplate)]] : []),
        [
            Markup.button.callback('📝 Шаблони', AdminCallbacks.Schedule),
        ],
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
