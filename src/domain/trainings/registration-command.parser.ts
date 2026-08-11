import { isValidReservedPlaces } from './reserved-places';

export type TrainingHint = {
    date?: string;
    naturalDate?: 'today' | 'tomorrow';
    time?: string;
    endTime?: string;
};

export type RegistrationCommand = {
    operation: 'add' | 'remove';
    /** Compatibility aliases for older callers; domain code uses operation/count. */
    action: '+' | '-';
    count: number;
    places: number;
    targetType: 'self' | 'named';
    targetText?: string;
    playerName?: string;
    targetNames: string[];
    trainingHint?: TrainingHint;
    date?: string;
    startTime?: string;
};

export class RegistrationCommandParseError extends Error {}

export class RegistrationCommandParser {
    normalize(text: string): string {
        return text.replace(/[−–—]/g, '-').trim().replace(/\s+/g, ' ');
    }

    parse(text: string): RegistrationCommand | undefined {
        const normalized = this.normalize(text);
        const sign = normalized[0];
        if (sign !== '+' && sign !== '-') return undefined;
        const operation = sign === '+' ? 'add' : 'remove';
        let body = normalized.slice(1).trim();
        let count = 1;

        const numeric = body.match(/^(\d+)(?:\s+(.*))?$/u);
        if (numeric) {
            count = Number(numeric[1]);
            body = numeric[2]?.trim() ?? '';
        } else if (operation === 'add') {
            throw new RegistrationCommandParseError('Можна додати або зняти від 1 до 4 місць.');
        }
        if (!isValidReservedPlaces(count)) throw new RegistrationCommandParseError('Можна додати або зняти від 1 до 4 місць.');

        const classified = this.extractTrainingHint(body);
        body = classified.remainingText;
        const selfWord = operation === 'remove' && /^(?:я|мене)$/iu.test(body);
        const self = !body || selfWord;
        if (!self && (body.match(/\p{L}/gu)?.length ?? 0) < 3) {
            throw new RegistrationCommandParseError('Не вдалося розпізнати імʼя або тренування. Уточніть команду.');
        }
        const targetNames = self ? [] : body.split(',').map((name) => name.trim()).filter(Boolean);
        if (!self && targetNames.length === 0) throw new RegistrationCommandParseError('Укажіть імʼя гравця.');
        if (targetNames.length > 1 && targetNames.length !== count) {
            throw new RegistrationCommandParseError(`Вказано ${count} місця, але знайдено ${targetNames.length} імені.`);
        }
        return {
            operation, action: sign, count, places: count,
            targetType: self ? 'self' : 'named',
            targetText: self ? undefined : body,
            playerName: self ? undefined : body,
            targetNames,
            trainingHint: classified.hint,
            date: classified.hint?.date ?? classified.hint?.naturalDate,
            startTime: classified.hint?.time,
        };
    }

    private extractTrainingHint(value: string): { remainingText: string; hint?: TrainingHint } {
        let text = value.trim();
        if (!text) return { remainingText: '' };

        // Legacy explicit selector remains supported.
        const legacy = text.match(/^(.*?)(?:\s+at\s+)(?:(\d{4}-\d{2}-\d{2})\s+)?(.+)$/iu);
        if (legacy) {
            const time = parseTime(legacy[3]);
            if (time) return { remainingText: legacy[1].trim(), hint: { date: legacy[2], ...time } };
        }

        // Name followed by an explicit time preposition.
        const suffixTime = text.match(/^(.*?)\s+(?:на|о|в)\s+(.+)$/iu);
        if (suffixTime) {
            const time = parseTime(suffixTime[2]);
            if (time) {
                const prefixDate = parseDate(suffixTime[1]);
                if (prefixDate) return { remainingText: '', hint: { ...prefixDate, ...time } };
                return { remainingText: suffixTime[1].trim(), hint: time };
            }
        }

        const withoutPreposition = text.replace(/^(?:на|о|в)\s+/iu, '').trim();
        const date = parseDate(withoutPreposition);
        if (date) return { remainingText: '', hint: date };
        const time = parseTime(withoutPreposition);
        if (time) return { remainingText: '', hint: time };

        return { remainingText: text };
    }
}

function parseDate(value: string): TrainingHint | undefined {
    const normalized = value.trim().toLocaleLowerCase('uk');
    if (normalized === 'сьогодні') return { naturalDate: 'today' };
    if (normalized === 'завтра') return { naturalDate: 'tomorrow' };
    const iso = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);
    if (iso) return { date: `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}` };
    const local = normalized.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/u);
    if (!local) return undefined;
    if (Number(local[1]) < 1 || Number(local[1]) > 31 || Number(local[2]) < 1 || Number(local[2]) > 12) return undefined;
    return { date: local[3] ? `${local[3]}-${pad(local[2])}-${pad(local[1])}` : `${pad(local[1])}.${pad(local[2])}` };
}

function parseTime(value: string): Pick<TrainingHint, 'time' | 'endTime'> | undefined {
    const normalized = value.trim().replace(/[–—]/g, '-');
    const match = normalized.match(/^(\d{1,2})(?:(?::|\.)(\d{2}))?(?:-(\d{1,2})(?:(?::|\.)(\d{2}))?)?$/u);
    if (!match) return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const endHour = match[3] === undefined ? undefined : Number(match[3]);
    const endMinute = Number(match[4] ?? 0);
    if (hour > 23 || minute > 59 || (endHour !== undefined && (endHour > 23 || endMinute > 59))) return undefined;
    return { time: `${pad(hour)}:${pad(minute)}`, endTime: endHour === undefined ? undefined : `${pad(endHour)}:${pad(endMinute)}` };
}

function pad(value: string | number): string { return String(value).padStart(2, '0'); }

export const registrationCommandParser = new RegistrationCommandParser();
