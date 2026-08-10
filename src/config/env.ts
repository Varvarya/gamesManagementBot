import path from 'node:path';

export type EnvConfig = { botToken: string; dataDir: string; logLevel: 'debug' | 'info' | 'warn' | 'error'; defaultTimezone: string; clubId?: string; clubName?: string; superAdminIds: number[] };

export function loadEnv(): EnvConfig {
    const required = (name: string): string => {
        const value = process.env[name]?.trim();
        if (!value) throw new Error(`${name} environment variable is required`);
        return value;
    };
    const botToken = required('BOT_TOKEN');
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('BOT_TOKEN has an invalid Telegram token format');
    const superAdminIds = parseSuperAdminIds(required('SUPER_ADMIN_IDS'));
    const logLevel = (process.env.LOG_LEVEL?.trim() || 'info') as EnvConfig['logLevel'];
    if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error('LOG_LEVEL must be debug, info, warn, or error');
    const defaultTimezone = process.env.DEFAULT_TIMEZONE?.trim() || 'Europe/Kyiv';
    try { new Intl.DateTimeFormat('en', { timeZone: defaultTimezone }).format(); } catch { throw new Error('DEFAULT_TIMEZONE is invalid'); }
    return { botToken, superAdminIds, dataDir: path.resolve(required('DATA_DIR')), logLevel, defaultTimezone, clubId: process.env.CLUB_ID?.trim() || undefined, clubName: process.env.CLUB_NAME?.trim() || undefined };
}

export function parseSuperAdminIds(raw: string): number[] {
    const value = raw.trim();
    let entries: unknown[];
    if (value.startsWith('[')) {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { throw new Error('SUPER_ADMIN_IDS must be a Telegram ID, comma-separated IDs, or a JSON array'); }
        if (!Array.isArray(parsed)) throw new Error('SUPER_ADMIN_IDS JSON value must be an array');
        entries = parsed;
    } else entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const ids = [...new Set(entries.map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('SUPER_ADMIN_IDS must contain positive Telegram user IDs');
    return ids;
}
