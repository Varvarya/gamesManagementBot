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
    hasExplicitDate: boolean;
    hasExplicitTime: boolean;
};

export class RegistrationCommandParseError extends Error {}

type ExtractedAction = { sign: '+' | '-'; count: number; remaining: string };
type NumericAction = { sign: '+' | '-'; countToken: string; start: number; length: number };
type TextExtraction<T> = { value?: T; remaining: string };

const RELATIVE_DAYS: Record<string, 'today' | 'tomorrow'> = {
    'сьогодні': 'today',
    'сегодня': 'today',
    'завтра': 'tomorrow',
};

const STOP_WORDS = [
    'будь ласка', 'пожалуйста', 'дякую', 'спасибо', 'пліз', 'плиз', 'прошу',
    'на', 'о', 'об', 'в', 'у', 'до', 'для', 'at',
    'мене', 'меня', 'собі', 'себе', 'я',
    'хочу', 'можна', 'запишіть', 'запишите', 'запиши', 'додайте', 'добавьте',
];

export class RegistrationCommandParser {
    normalize(text: string): string {
        return text.replace(/[−–—]/g, '-').trim().replace(/\s+/g, ' ');
    }

    hasOperation(text: string): boolean {
        const normalized = this.normalize(text);
        return this.findNumericAction(normalized) !== undefined || /^[+-](?:\s|\p{L}|$)/u.test(normalized);
    }

    parse(text: string): RegistrationCommand | undefined {
        const normalized = this.normalize(text);
        const extractedAction = this.extractOperationAndCount(normalized);
        if (!extractedAction) return undefined;
        if (!isValidReservedPlaces(extractedAction.count)) {
            throw new RegistrationCommandParseError('Можна додати або зняти від 1 до 4 місць.');
        }

        const relative = this.extractRelativeDate(extractedAction.remaining);
        const explicitDate = this.extractExplicitDate(relative.remaining);
        const time = this.extractTime(explicitDate.remaining, Boolean(relative.value || explicitDate.value));
        const targetText = this.extractPossibleTargetName(time.remaining);
        const targetNames = targetText
            ? targetText.split(',').map((name) => name.trim()).filter(Boolean)
            : [];
        if (targetNames.length > 1 && targetNames.length !== extractedAction.count) {
            throw new RegistrationCommandParseError(`Вказано ${extractedAction.count} місця, але знайдено ${targetNames.length} імені.`);
        }
        const hint: TrainingHint = {
            naturalDate: relative.value,
            date: explicitDate.value,
            time: time.value?.time,
            endTime: time.value?.endTime,
        };
        const hasHint = Object.values(hint).some(Boolean);
        return {
            operation: extractedAction.sign === '+' ? 'add' : 'remove',
            action: extractedAction.sign,
            count: extractedAction.count,
            places: extractedAction.count,
            targetType: targetNames.length ? 'named' : 'self',
            targetText: targetNames.length ? targetText : undefined,
            playerName: targetNames.length ? targetText : undefined,
            targetNames,
            trainingHint: hasHint ? hint : undefined,
            date: explicitDate.value ?? relative.value,
            startTime: time.value?.time,
            hasExplicitDate: Boolean(relative.value || explicitDate.value),
            hasExplicitTime: Boolean(time.value?.time),
        };
    }

    private extractOperationAndCount(text: string): ExtractedAction | undefined {
        const numeric = this.findNumericAction(text);
        if (numeric) {
            return { sign: numeric.sign, count: Number(numeric.countToken), remaining: replaceSpan(text, numeric.start, numeric.length) };
        }

        // Preserve the established shorthand forms: "-", "- я", and "- Name".
        const legacyRemove = text.match(/^-\s*(.*)$/u);
        if (legacyRemove) return { sign: '-', count: 1, remaining: legacyRemove[1] };
        if (/^\+/u.test(text)) throw new RegistrationCommandParseError('Можна додати або зняти від 1 до 4 місць.');
        return undefined;
    }

    private findNumericAction(text: string): NumericAction | undefined {
        return findAction(text);
    }

    private extractRelativeDate(text: string): TextExtraction<'today' | 'tomorrow'> {
        for (const [word, value] of Object.entries(RELATIVE_DAYS)) {
            const match = new RegExp(`(^|[^\\p{L}])${word}(?=$|[^\\p{L}])`, 'iu').exec(text);
            if (match) return { value, remaining: replaceSpan(text, match.index + match[1].length, word.length) };
        }
        return { remaining: text };
    }

    private extractExplicitDate(text: string): TextExtraction<string> {
        const candidates = [...text.matchAll(/(?:^|[^\d])(\d{1,4}([./-])\d{1,2}(?:\2\d{2,4})?\.?)(?=$|[^\d])/gu)];
        for (const match of candidates) {
            const parsed = parseDateToken(match[1]);
            if (!parsed) continue;
            const offset = match.index! + match[0].indexOf(match[1]);
            return { value: parsed, remaining: replaceSpan(text, offset, match[1].length) };
        }
        return { remaining: text };
    }

    private extractTime(text: string, hasDateContext: boolean): TextExtraction<{ time: string; endTime?: string }> {
        const range = findTime(text, /(?:^|[^\d])(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})(?=$|[^\d])/gu);
        if (range) return range;
        const separated = findTime(text, /(?:^|[^\d])(\d{1,2}[:.-]\d{2})(?=$|[^\d])/gu);
        if (separated) return separated;
        const contextualPair = findTime(text, /(?:^|\s)(?:о|об|в|у|на)\s+(\d{1,2})\s+(\d{2})(?=$|\s|[,!?)])/giu);
        if (contextualPair) return contextualPair;
        const fullHour = findTime(text, /(?:^|\s)(?:о|об|в|у|на)\s+(\d{1,2})(?=$|\s|[,!?)])/giu);
        if (fullHour) return fullHour;
        // Existing commands such as "+1 12" treat the lone number as a training discriminator.
        if (hasDateContext || /^\s*\d{1,2}\s*[^\p{L}\p{N}]*$/u.test(text)) {
            const bareHour = findTime(text, /(?:^|[^\d])(\d{1,2})(?=$|[^\d])/gu);
            if (bareHour) return bareHour;
        }
        return { remaining: text };
    }

    private extractPossibleTargetName(text: string): string | undefined {
        let remaining = text;
        for (const phrase of STOP_WORDS.sort((a, b) => b.length - a.length)) {
            remaining = remaining.replace(new RegExp(`(^|[^\\p{L}])${escapeRegExp(phrase)}(?=$|[^\\p{L}])`, 'giu'), '$1 ');
        }
        remaining = remaining
            .replace(/[^\p{L}\p{M},'’ʼ-]+/gu, ' ')
            .replace(/\s*,\s*/g, ', ')
            .replace(/\s+/g, ' ')
            .replace(/^(?:[,\s-]+)|(?:[,\s-]+)$/g, '')
            .trim();
        if (!remaining || !/\p{L}/u.test(remaining)) return undefined;
        if ((remaining.match(/\p{L}/gu)?.length ?? 0) < 3) return undefined;
        return remaining;
    }
}

function findAction(text: string): NumericAction | undefined {
    const regex = /(?:^|[^\p{L}\p{N}])([+-])\s*(\d+)(?!\d)/gu;
    const match = regex.exec(text);
    if (!match) return undefined;
    const actionStart = match.index + match[0].search(/[+-]/u);
    if (!isValidReservedPlaces(Number(match[2])) && actionStart !== 0) return undefined;
    return { sign: match[1] as '+' | '-', countToken: match[2], start: actionStart, length: regex.lastIndex - actionStart };
}

function findTime(text: string, regex: RegExp): TextExtraction<{ time: string; endTime?: string }> | undefined {
    for (const match of text.matchAll(regex)) {
        const clockInFirstToken = /[:.\-]/u.test(match[1]);
        const first = parseClock(match[1], clockInFirstToken ? undefined : match[2]);
        if (!first) continue;
        const isRange = clockInFirstToken && Boolean(match[2]);
        const end = isRange ? parseClock(match[2]) : undefined;
        const tokenStart = match.index! + match[0].indexOf(match[1]);
        const tokenEnd = match[2]
            ? match.index! + match[0].lastIndexOf(match[2]) + match[2].length
            : tokenStart + match[1].length;
        return { value: { time: first, endTime: end }, remaining: replaceSpan(text, tokenStart, tokenEnd - tokenStart) };
    }
    return undefined;
}

function parseClock(hourToken: string, separateMinute?: string): string | undefined {
    const parts = hourToken.split(/[:.\-]/u);
    const hour = Number(parts[0]);
    const minute = Number(separateMinute ?? parts[1] ?? 0);
    if (hour > 23 || minute > 59) return undefined;
    return `${pad(hour)}:${pad(minute)}`;
}

function parseDateToken(value: string): string | undefined {
    const normalized = value.replace(/\.$/u, '');
    const parts = normalized.split(/[./-]/u);
    if (parts.length === 3 && parts[0].length === 4) {
        const [year, month, day] = parts.map(Number);
        return validDate(day, month, year) ? `${year}-${pad(month)}-${pad(day)}` : undefined;
    }
    const [day, month, yearValue] = parts.map(Number);
    const year = parts.length === 3 ? (parts[2].length === 2 ? 2000 + yearValue : yearValue) : undefined;
    if (!validDate(day, month, year)) return undefined;
    return year ? `${year}-${pad(month)}-${pad(day)}` : `${pad(day)}.${pad(month)}`;
}

function validDate(day: number, month: number, year?: number): boolean {
    if (day < 1 || day > 31 || month < 1 || month > 12) return false;
    if (year !== undefined && (year < 2000 || year > 9999)) return false;
    return true;
}

function replaceSpan(text: string, start: number, length: number): string {
    return `${text.slice(0, start)} ${text.slice(start + length)}`;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function pad(value: string | number): string { return String(value).padStart(2, '0'); }

export const registrationCommandParser = new RegistrationCommandParser();
