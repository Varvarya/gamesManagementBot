export const PLAYER_CSV_COLUMNS = ['displayName', 'telegramUserId', 'telegramUsername', 'aliases', 'confirmed', 'active'] as const;

export type PlayerCsvRow = {
    rowNumber: number;
    displayName: string;
    telegramUserId?: number;
    telegramUsername?: string;
    aliases?: string[];
    confirmed?: boolean;
    active?: boolean;
};

export type PlayerCsvError = { rowNumber: number; field?: string; message: string };
export type PlayerCsvParseResult = { rows: PlayerCsvRow[]; errors: PlayerCsvError[]; delimiter: ',' | ';' };

export class PlayerCsvParser {
    parse(input: string | Buffer): PlayerCsvParseResult {
        const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
        const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const firstLine = normalized.split('\n').find((line) => line.trim()) ?? '';
        if (!firstLine) throw new Error('Файл не схожий на CSV.');
        const delimiter = detectDelimiter(firstLine);
        const records = parseRecords(normalized, delimiter).filter((record) => record.some((field) => field.trim()));
        if (!records.length) throw new Error('Файл не схожий на CSV.');
        const headers = records[0].map((field) => field.trim().replace(/^\uFEFF/, ''));
        const displayIndex = headers.indexOf('displayName');
        if (displayIndex < 0) throw new Error('Не знайдено колонку displayName.');
        const supported = new Set<string>(PLAYER_CSV_COLUMNS);
        const indexes = new Map(headers.filter((header) => supported.has(header)).map((header) => [header, headers.indexOf(header)]));
        const rows: PlayerCsvRow[] = [];
        const errors: PlayerCsvError[] = [];
        records.slice(1).forEach((record, index) => {
            const rowNumber = index + 2;
            const field = (name: string) => {
                const position = indexes.get(name);
                return position === undefined ? undefined : record[position]?.trim();
            };
            const displayName = field('displayName')?.replace(/\s+/g, ' ') ?? '';
            if (!displayName) { errors.push({ rowNumber, field: 'displayName', message: 'відсутнє displayName' }); return; }
            const telegramRaw = field('telegramUserId');
            const telegramUserId = telegramRaw ? Number(telegramRaw) : undefined;
            if (telegramRaw && (!Number.isSafeInteger(telegramUserId) || telegramUserId! <= 0)) {
                errors.push({ rowNumber, field: 'telegramUserId', message: 'telegramUserId має неправильний формат' }); return;
            }
            const confirmed = parseBoolean(field('confirmed'), rowNumber, 'confirmed', errors);
            const active = parseBoolean(field('active'), rowNumber, 'active', errors);
            if (errors.some((error) => error.rowNumber === rowNumber)) return;
            const aliasRaw = field('aliases');
            rows.push({
                rowNumber, displayName, telegramUserId,
                telegramUsername: cleanUsername(field('telegramUsername')),
                aliases: aliasRaw ? uniqueValues(aliasRaw.split('|')) : undefined,
                confirmed, active,
            });
        });
        return { rows, errors, delimiter };
    }
}

function detectDelimiter(header: string): ',' | ';' {
    const commas = countOutsideQuotes(header, ',');
    const semicolons = countOutsideQuotes(header, ';');
    return semicolons > commas ? ';' : ',';
}

function countOutsideQuotes(value: string, needle: string): number {
    let quoted = false;
    let count = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] === '"') quoted = !quoted;
        else if (!quoted && value[index] === needle) count++;
    }
    return count;
}

function parseRecords(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            if (quoted && text[index + 1] === '"') { field += '"'; index++; }
            else quoted = !quoted;
        } else if (!quoted && char === delimiter) { row.push(field); field = ''; }
        else if (!quoted && char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += char;
    }
    if (quoted) throw new Error('Файл не схожий на CSV: незакрите поле в лапках.');
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function parseBoolean(value: string | undefined, rowNumber: number, field: string, errors: PlayerCsvError[]): boolean | undefined {
    if (!value) return undefined;
    const key = value.toLocaleLowerCase();
    if (['true', '1', 'yes'].includes(key)) return true;
    if (['false', '0', 'no'].includes(key)) return false;
    errors.push({ rowNumber, field, message: `${field} = "${value}" має неправильне значення` });
    return undefined;
}

function uniqueValues(values: string[]): string[] {
    const result = new Map<string, string>();
    for (const raw of values) {
        const value = raw.trim().replace(/\s+/g, ' ');
        if (value) result.set(normalize(value), value);
    }
    return [...result.values()];
}

function cleanUsername(value: string | undefined): string | undefined { return value?.replace(/^@/, '').trim() || undefined; }
export function normalizePlayerValue(value: string): string { return normalize(value); }
function normalize(value: string): string { return value.trim().replace(/\s+/g, ' ').replace(/^@/, '').toLocaleLowerCase('uk'); }

export function escapeCsv(value: unknown): string {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
