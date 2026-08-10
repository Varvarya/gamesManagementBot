import { Markup } from 'telegraf';

export function assertCallbackDataValid(data: string, prefix = 'unknown', entityType = 'unknown'): string {
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > 64) throw new Error(`Invalid callback_data: prefix=${prefix}, bytes=${bytes}, entity=${entityType}`);
    return data;
}

/** @deprecated Use assertCallbackDataValid. */
export const validateCallbackData = assertCallbackDataValid;

export function callbackButton(text: string, data: string, prefix: string, entityType: string) {
    return Markup.button.callback(text, assertCallbackDataValid(data, prefix, entityType));
}
