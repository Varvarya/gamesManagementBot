import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createFlowCancelKeyboard(
    backCallback: string = AdminCallbacks.MainMenu,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '❌ Скасувати',
                backCallback,
            ),
        ],
    ]);
}