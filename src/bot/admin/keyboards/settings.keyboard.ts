import { Markup } from 'telegraf';
import { ClubAdmin } from '../../../domain/settings/settings.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createSettingsKeyboard(cleanChatMode: boolean) {
    const edit = AdminCallbacks.SettingsEditPrefix;
    return Markup.inlineKeyboard([
        [Markup.button.callback('👥 Адміністратори', AdminCallbacks.SettingsAdmins)],
        [Markup.button.callback('🏷 Назва клубу', `${edit}title`), Markup.button.callback('🕒 Часовий пояс', `${edit}timezone`)],
        [Markup.button.callback('🧹 Очищення чату', AdminCallbacks.SettingsToggleCleanChat)],
        [Markup.button.callback('✅ Перевірка налаштувань', AdminCallbacks.Readiness)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Back)],
    ]);
}

export function createAdminsKeyboard(canManage: boolean, canTransfer: boolean) {
    return Markup.inlineKeyboard([
        ...(canManage ? [[Markup.button.callback('➕ Додати адміністратора', AdminCallbacks.SettingsAddAdmin), Markup.button.callback('➖ Видалити адміністратора', AdminCallbacks.SettingsRemoveAdmin)]] : []),
        ...(canTransfer ? [[Markup.button.callback('👑 Передати owner', AdminCallbacks.SettingsTransferOwner)]] : []),
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Back)],
    ]);
}

export function createAdminConfirmationKeyboard(confirmCallback: string) {
    return Markup.inlineKeyboard([[Markup.button.callback('✅ Підтвердити', confirmCallback)], [Markup.button.callback('❌ Скасувати', AdminCallbacks.SettingsAdmins)]]);
}

export function createStatusKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Оновити', AdminCallbacks.SettingsStatus)],
        [Markup.button.callback('◀️ До налаштувань', AdminCallbacks.Back)],
    ]);
}
