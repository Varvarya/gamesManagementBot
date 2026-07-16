import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createSettingsKeyboard(
    cleanChatMode: boolean,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '⏰ Час перевірки мінімуму',
                AdminCallbacks.SettingsCancelHours,
            ),
        ],
        [
            Markup.button.callback(
                cleanChatMode
                    ? '🧹 Видалення +1: увімкнено'
                    : '💬 Видалення +1: вимкнено',
                AdminCallbacks.SettingsToggleCleanChat,
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