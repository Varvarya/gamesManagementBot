export type TelegramAuthFailureCode =
    | 'TELEGRAM_API_CREDENTIALS_INVALID'
    | 'PHONE_NUMBER_INVALID'
    | 'PHONE_NUMBER_BANNED'
    | 'PHONE_CODE_INVALID'
    | 'PHONE_CODE_EXPIRED'
    | 'SESSION_PASSWORD_NEEDED'
    | 'PASSWORD_HASH_INVALID'
    | 'AUTH_KEY_UNREGISTERED'
    | 'FLOOD_WAIT'
    | 'NETWORK_ERROR'
    | 'SESSION_ENCRYPTION_FAILED'
    | 'SESSION_PERSIST_FAILED'
    | 'AUTH_FLOW_EXPIRED'
    | 'UNKNOWN_AUTH_ERROR';

export class TelegramAuthError extends Error {
    constructor(
        readonly reason: TelegramAuthFailureCode,
        readonly stage: string,
        readonly original: unknown,
    ) {
        super(safeTelegramErrorDetails(original).message || reason, { cause: original });
        this.name = 'TelegramAuthError';
    }
}

export function classifyTelegramAuthError(error: unknown, stage = 'unknown'): TelegramAuthError {
    if (error instanceof TelegramAuthError) return error;
    const details = safeTelegramErrorDetails(error);
    const value = `${details.name} ${details.message} ${details.errorMessage} ${details.code}`.toUpperCase();
    let reason: TelegramAuthFailureCode = 'UNKNOWN_AUTH_ERROR';
    if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD|API_HASH/.test(value)) reason = 'TELEGRAM_API_CREDENTIALS_INVALID';
    else if (/PHONE_NUMBER_BANNED/.test(value)) reason = 'PHONE_NUMBER_BANNED';
    else if (/PHONE_NUMBER_INVALID/.test(value)) reason = 'PHONE_NUMBER_INVALID';
    else if (/PHONE_CODE_INVALID/.test(value)) reason = 'PHONE_CODE_INVALID';
    else if (/PHONE_CODE_EXPIRED|PHONE_CODE_EMPTY/.test(value)) reason = 'PHONE_CODE_EXPIRED';
    else if (/SESSION_PASSWORD_NEEDED/.test(value)) reason = 'SESSION_PASSWORD_NEEDED';
    else if (/PASSWORD_HASH_INVALID/.test(value)) reason = 'PASSWORD_HASH_INVALID';
    else if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID/.test(value)) reason = 'AUTH_KEY_UNREGISTERED';
    else if (/FLOOD_WAIT|FLOOD_PREMIUM_WAIT|420/.test(value)) reason = 'FLOOD_WAIT';
    else if (/ECONN|ETIMEDOUT|ENETUNREACH|NETWORK|TIMEOUT|CONNECTION/.test(value)) reason = 'NETWORK_ERROR';
    return new TelegramAuthError(reason, stage, error);
}

export function safeTelegramErrorDetails(error: unknown): { name: string; message: string; code?: string | number; errorMessage?: string; stack?: string } {
    const value = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
    return {
        name: error instanceof Error ? error.name : typeof value?.name === 'string' ? value.name : 'Error',
        message: error instanceof Error ? error.message : typeof value?.message === 'string' ? value.message : String(error ?? ''),
        code: typeof value?.code === 'string' || typeof value?.code === 'number' ? value.code : undefined,
        errorMessage: typeof value?.errorMessage === 'string' ? value.errorMessage : undefined,
        stack: error instanceof Error ? error.stack : undefined,
    };
}

export function isRetryableTelegramAuthFailure(reason: TelegramAuthFailureCode): boolean {
    return reason === 'PHONE_CODE_INVALID' || reason === 'PASSWORD_HASH_INVALID';
}

export function normalizeTelegramPhone(value: string): string {
    const trimmed = value.trim();
    const digits = trimmed.replace(/[^\d]/g, '');
    if (!digits || digits.length < 8 || digits.length > 15 || /[A-Za-zА-Яа-яІіЇїЄє]/u.test(trimmed)) throw new TelegramAuthError('PHONE_NUMBER_INVALID', 'phone_submitted', new Error('Phone number has invalid format'));
    return `+${digits}`;
}

export function normalizeTelegramCode(value: string): string {
    const code = value.replace(/\s+/g, '');
    if (!/^\d{4,10}$/.test(code)) throw new TelegramAuthError('PHONE_CODE_INVALID', 'code_submitted', new Error('Confirmation code has invalid format'));
    return code;
}

export type TelegramMtprotoConfig = { apiId: number; apiHash: string; encryptionKey: string; apiIdPresent: boolean; apiHashPresent: boolean; encryptionKeyPresent: boolean; valid: boolean };

export function readTelegramMtprotoConfig(env: NodeJS.ProcessEnv = process.env): TelegramMtprotoConfig {
    const rawApiId = env.TELEGRAM_API_ID?.trim() ?? '';
    const apiHash = env.TELEGRAM_API_HASH?.trim() ?? '';
    const encryptionKey = env.TELEGRAM_SESSION_ENCRYPTION_KEY?.trim() ?? '';
    const apiId = Number(rawApiId);
    const apiIdPresent = Boolean(rawApiId);
    return { apiId, apiHash, encryptionKey, apiIdPresent, apiHashPresent: Boolean(apiHash), encryptionKeyPresent: Boolean(encryptionKey), valid: apiIdPresent && Number.isSafeInteger(apiId) && apiId > 0 && Boolean(apiHash && encryptionKey) };
}

export function telegramAuthUserMessage(error: unknown): string {
    const reason = error instanceof TelegramAuthError ? error.reason : classifyTelegramAuthError(error).reason;
    switch (reason) {
        case 'PHONE_NUMBER_INVALID': return 'Невірний номер телефону.';
        case 'PHONE_NUMBER_BANNED': return 'Telegram заблокував цей номер для авторизації.';
        case 'PHONE_CODE_INVALID': return 'Код підтвердження невірний. Спробуйте ще раз.';
        case 'PHONE_CODE_EXPIRED': return 'Код підтвердження вже неактуальний. Запросіть новий.';
        case 'PASSWORD_HASH_INVALID': return 'Невірний пароль двоетапної перевірки.';
        case 'FLOOD_WAIT': return 'Telegram тимчасово обмежив спроби. Спробуйте пізніше.';
        case 'TELEGRAM_API_CREDENTIALS_INVALID': return 'Підключення Telegram неправильно налаштовано на сервері.';
        case 'AUTH_FLOW_EXPIRED': return 'Час підключення минув. Почніть авторизацію знову.';
        case 'NETWORK_ERROR': return 'Не вдалося звʼязатися з Telegram. Спробуйте ще раз.';
        case 'SESSION_ENCRYPTION_FAILED':
        case 'SESSION_PERSIST_FAILED': return 'Telegram авторизовано, але не вдалося безпечно зберегти підключення.';
        default: return 'Не вдалося підключити Telegram. Деталі записано в лог.';
    }
}
