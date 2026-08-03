import { Markup } from 'telegraf';
import { ClubAdmin } from '../../../domain/settings/settings.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createSettingsKeyboard(cleanChatMode: boolean) {
    const edit = AdminCallbacks.SettingsEditPrefix;
    return Markup.inlineKeyboard([
        [Markup.button.callback('🏸 Назва клубу', `${edit}title`), Markup.button.callback('🌍 Часовий пояс', `${edit}timezone`)],
        [Markup.button.callback('👮 Адміністратори', AdminCallbacks.SettingsAdmins), Markup.button.callback(cleanChatMode ? '🧹 Очищення: увімкнено' : '🧹 Очищення: вимкнено', AdminCallbacks.SettingsToggleCleanChat)],
        [Markup.button.callback('📊 Статус', AdminCallbacks.SettingsStatus)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.MainMenu)],
    ]);
}

export function createAdminsKeyboard(admins: ClubAdmin[]) {
    return Markup.inlineKeyboard([
        ...admins.map((admin) => [Markup.button.callback(`➖ ${admin.telegramUserId} (${admin.role})`, `${AdminCallbacks.SettingsRemoveAdminPrefix}${admin.telegramUserId}`)]),
        [Markup.button.callback('➕ Додати адміністратора', AdminCallbacks.SettingsAddAdmin)],
        [Markup.button.callback('◀️ Налаштування', AdminCallbacks.Settings)],
    ]);
}

export function createStatusKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Оновити', AdminCallbacks.SettingsStatus)],
        [Markup.button.callback('◀️ До налаштувань', AdminCallbacks.Settings)],
    ]);
}
