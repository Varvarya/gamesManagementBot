import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { ClubReadiness } from '../../../domain/clubs/club-readiness.service';

export function createSetupOverviewKeyboard(ready: boolean) {
    return Markup.inlineKeyboard(ready ? [
        [Markup.button.callback('🏠 До меню клубу', AdminCallbacks.MainMenu)],
        [Markup.button.callback('📅 Відкрити розклад', AdminCallbacks.Schedule)],
    ] : [
        [Markup.button.callback('▶️ Продовжити налаштування', AdminCallbacks.SetupContinue)],
        [Markup.button.callback('🏠 Перейти до меню', AdminCallbacks.MainMenu)],
    ]);
}

export function createSetupStepKeyboard(readiness: ClubReadiness) {
    const warning = readiness.warnings[0];
    const action = warning?.repair === 'identity' ? `${AdminCallbacks.SettingsEditPrefix}title`
        : warning?.repair === 'admins' ? AdminCallbacks.SettingsAdmins
            : warning?.repair === 'chat' ? AdminCallbacks.AddChat : AdminCallbacks.CreateTemplate;
    return Markup.inlineKeyboard([
        [Markup.button.callback(warning?.repair === 'chat' ? '➕ Додати чат' : warning?.repair === 'schedule' ? '➕ Додати до розкладу' : '▶️ Виправити', action)],
        [Markup.button.callback('⏭ Пропустити', AdminCallbacks.MainMenu)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Setup)],
    ]);
}

export function createReadinessKeyboard(readiness: ClubReadiness) {
    if (readiness.ready) return Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', AdminCallbacks.Settings)]]);
    return Markup.inlineKeyboard([
        [Markup.button.callback('▶️ Виправити', AdminCallbacks.SetupContinue)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Settings)],
    ]);
}
