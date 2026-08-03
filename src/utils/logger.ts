export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;
export type LastErrorLog = { timestamp: string; event: string; message?: string };

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minimumLevel: LogLevel = 'info';
let lastError: LastErrorLog | undefined;

function normalize(value: unknown): unknown {
    if (value instanceof Error) {
        return { name: value.name, message: value.message };
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
}

export function configureLogger(level: LogLevel): void {
    minimumLevel = level;
}

export function getLastErrorLog(): LastErrorLog | undefined {
    return lastError ? { ...lastError } : undefined;
}

export const logger = {
    debug(event: string, fields: LogFields = {}): void { write('debug', event, fields); },
    info(event: string, fields: LogFields = {}): void { write('info', event, fields); },
    warn(event: string, fields: LogFields = {}): void { write('warn', event, fields); },
    error(event: string, fields: LogFields = {}): void { write('error', event, fields); },
};

function write(level: LogLevel, event: string, fields: LogFields): void {
    const timestamp = new Date().toISOString();
    if (level === 'error') {
        const error = fields.error;
        lastError = {
            timestamp,
            event,
            message: error instanceof Error
                ? error.message
                : typeof error === 'string'
                    ? error
                    : undefined,
        };
    }
    if (priorities[level] < priorities[minimumLevel]) return;
    const record = JSON.stringify({
        timestamp,
        level,
        event,
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, normalize(value)])),
    });
    if (level === 'error') console.error(record);
    else if (level === 'warn') console.warn(record);
    else console.info(record);
}
