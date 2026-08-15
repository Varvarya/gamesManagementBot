import { Player } from './player.types';
import { PlayerCsvError, PlayerCsvParser, PlayerCsvRow, normalizePlayerValue } from './player-csv';
import { PlayersRepository } from '../../storage/repositories/players.repository';
import { createId } from '../../utils/ids';
import { logger } from '../../utils/logger';

export type PlayerImportConflict = { type: 'csv_telegram_duplicate' | 'csv_name_duplicate' | 'ambiguous_exact_match'; rows: number[]; message: string; candidatePlayerIds?: string[]; importCandidateIds?: string[] };
export type PlayerImportOperation = { kind: 'create' | 'update' | 'unchanged'; rowNumber: number; player: Player; changes: string[]; importCandidateId?: string };
export type PlayerImportRowResolution = { kind: 'existing'; playerId: string } | { kind: 'create' };
export type PlayerImportPreviewOptions = { rowResolutions?: Readonly<Record<number, PlayerImportRowResolution>>; skippedRows?: readonly number[]; importCandidateIds?: Readonly<Record<number, string>> };
export type PlayerImportPlan = {
    clubId: string; createdAt: string; baseline: string; rowCount: number;
    operations: PlayerImportOperation[]; conflicts: PlayerImportConflict[]; errors: PlayerCsvError[];
    newCount: number; updateCount: number; unchangedCount: number; conflictCount: number; errorCount: number;
    blockedCount: number; canCommit: boolean;
};

export class PlayerImportService {
    private readonly parser = new PlayerCsvParser();
    private commitQueue: Promise<void> = Promise.resolve();
    constructor(
        private readonly clubId: string,
        private readonly players: PlayersRepository,
        private readonly createBackup: () => Promise<unknown>,
    ) {}

    async preview(csv: string | Buffer, options: PlayerImportPreviewOptions = {}): Promise<PlayerImportPlan> {
        logger.info('player_import_started', { clubId: this.clubId });
        const parsed = this.parser.parse(csv);
        logger.info('player_import_parsed', { clubId: this.clubId, rowCount: parsed.rows.length, errorCount: parsed.errors.length });
        const existing = await this.players.list();
        const skippedRows = new Set(options.skippedRows ?? []);
        const activeRows = parsed.rows.filter((row) => !skippedRows.has(row.rowNumber));
        const explicitlyResolvedRows = new Set(Object.keys(options.rowResolutions ?? {}).map(Number));
        const conflicts = findCsvConflicts(activeRows, explicitlyResolvedRows).map((conflict) => withCandidateIds(conflict, options.importCandidateIds));
        const blockedRows = new Set(conflicts.flatMap((conflict) => conflict.rows));
        const operations: PlayerImportOperation[] = [];
        for (const row of parsed.rows) {
            if (skippedRows.has(row.rowNumber)) continue;
            if (blockedRows.has(row.rowNumber)) continue;
            const resolution = options.rowResolutions?.[row.rowNumber];
            if (resolution?.kind === 'create') { operations.push(withOperationCandidateId({ kind: 'create', rowNumber: row.rowNumber, player: createPlayer(row), changes: ['new'] }, options.importCandidateIds)); continue; }
            if (resolution?.kind === 'existing') {
                const selected = existing.find((player) => player.id === resolution.playerId);
                if (!selected) { conflicts.push(withCandidateIds({ type: 'ambiguous_exact_match', rows: [row.rowNumber], message: `Рядок ${row.rowNumber}: вибраного гравця не знайдено` }, options.importCandidateIds)); continue; }
                operations.push(withOperationCandidateId(mergeExisting(selected, row), options.importCandidateIds)); continue;
            }
            const match = matchPlayer(row, existing);
            if (match.kind === 'ambiguous') {
                conflicts.push(withCandidateIds({ type: 'ambiguous_exact_match', rows: [row.rowNumber], candidatePlayerIds: match.players.map((player) => player.id), message: `Рядок ${row.rowNumber}: знайдено кілька гравців із таким імʼям` }, options.importCandidateIds));
                continue;
            }
            if (match.kind === 'none') {
                operations.push(withOperationCandidateId({ kind: 'create', rowNumber: row.rowNumber, player: createPlayer(row), changes: ['new'] }, options.importCandidateIds));
                continue;
            }
            operations.push(withOperationCandidateId(mergeExisting(match.player, row), options.importCandidateIds));
        }
        const rowCount = new Set([...parsed.rows.map((row) => row.rowNumber), ...parsed.errors.map((error) => error.rowNumber)]).size;
        const plan = summarize({ clubId: this.clubId, createdAt: new Date().toISOString(), baseline: fingerprint(existing), rowCount, operations, conflicts, errors: parsed.errors });
        if (plan.conflictCount) logger.warn('player_import_conflict', { clubId: this.clubId, rowCount: plan.rowCount, conflictCount: plan.conflictCount, errorCount: plan.errorCount });
        logger.info('player_import_preview_created', { clubId: this.clubId, rowCount: plan.rowCount, newCount: plan.newCount, updateCount: plan.updateCount, conflictCount: plan.conflictCount, errorCount: plan.errorCount });
        return plan;
    }

    async commit(plan: PlayerImportPlan): Promise<{ created: number; updated: number; unchanged: number }> {
        return this.serializeCommit(() => this.commitPlan(plan));
    }

    private async commitPlan(plan: PlayerImportPlan): Promise<{ created: number; updated: number; unchanged: number }> {
        if (plan.clubId !== this.clubId || plan.conflicts.length || plan.errors.length) throw new Error('IMPORT_PLAN_BLOCKED');
        const current = await this.players.list();
        if (fingerprint(current) !== plan.baseline) throw new Error('IMPORT_PLAN_STALE');
        try {
            await this.createBackup();
            logger.info('player_import_backup_created', { clubId: this.clubId });
        } catch (error) {
            logger.error('player_import_failed', { clubId: this.clubId, reason: 'backup_failed', error });
            throw new Error('Не вдалося створити резервну копію. Імпорт скасовано.', { cause: error });
        }
        const next = structuredClone(current);
        for (const operation of plan.operations) {
            if (operation.kind === 'unchanged') continue;
            const index = next.findIndex((player) => player.id === operation.player.id);
            if (index < 0) next.push(structuredClone(operation.player));
            else next[index] = structuredClone(operation.player);
        }
        try { await this.players.saveAll(next); }
        catch (error) {
            logger.error('player_import_failed', { clubId: this.clubId, reason: 'write_failed', error });
            throw new Error('Не вдалося зберегти імпорт. Попередні дані залишилися чинними.', { cause: error });
        }
        logger.info('player_import_completed', { clubId: this.clubId, rowCount: plan.rowCount, newCount: plan.newCount, updateCount: plan.updateCount, conflictCount: 0, errorCount: 0 });
        return { created: plan.newCount, updated: plan.updateCount, unchanged: plan.unchangedCount };
    }

    private async serializeCommit<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.commitQueue;
        let release!: () => void;
        this.commitQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); }
        finally { release(); }
    }
}

function findCsvConflicts(rows: PlayerCsvRow[], explicitlyResolvedRows: ReadonlySet<number>): PlayerImportConflict[] {
    const byTelegram = new Map<number, PlayerCsvRow[]>();
    for (const row of rows) if (row.telegramUserId !== undefined) byTelegram.set(row.telegramUserId, [...(byTelegram.get(row.telegramUserId) ?? []), row]);
    const conflicts: PlayerImportConflict[] = [...byTelegram].filter(([, values]) => values.length > 1).map(([telegramUserId, values]) => ({
        type: 'csv_telegram_duplicate', rows: values.map((row) => row.rowNumber),
        message: `telegramUserId ${telegramUserId} використано декілька разів`,
    }));
    const byName = new Map<string, PlayerCsvRow[]>();
    // An explicit create/merge decision resolves name ambiguity for that row.
    // Telegram identity duplicates remain hard conflicts and are intentionally
    // checked above even when a row has an explicit resolution.
    for (const row of rows) {
        if (explicitlyResolvedRows.has(row.rowNumber)) continue;
        const key = normalizePlayerValue(row.displayName);
        byName.set(key, [...(byName.get(key) ?? []), row]);
    }
    for (const values of byName.values()) if (values.length > 1) conflicts.push({
        type: 'csv_name_duplicate', rows: values.map((row) => row.rowNumber),
        message: `Імʼя «${values[0].displayName}» повторюється у файлі; рядки потребують окремого рішення`,
    });
    return conflicts;
}

function matchPlayer(row: PlayerCsvRow, players: Player[]): { kind: 'none' } | { kind: 'one'; player: Player } | { kind: 'ambiguous'; players: Player[] } {
    if (row.telegramUserId !== undefined) {
        const matches = players.filter((player) => player.telegramUserId === row.telegramUserId);
        if (matches.length === 1) return { kind: 'one', player: matches[0] };
        if (matches.length > 1) return { kind: 'ambiguous', players: matches };
    }
    const key = normalizePlayerValue(row.displayName);
    const matches = players.filter((player) => [player.displayName, ...player.aliases].some((value) => normalizePlayerValue(value) === key));
    if (matches.length === 1) return { kind: 'one', player: matches[0] };
    if (matches.length > 1) return { kind: 'ambiguous', players: matches };
    return { kind: 'none' };
}

function createPlayer(row: PlayerCsvRow): Player {
    const now = new Date().toISOString();
    return { id: createId('player'), displayName: row.displayName, telegramUserId: row.telegramUserId, username: row.telegramUsername,
        aliases: row.aliases ?? [], isConfirmed: row.confirmed ?? false, isActive: row.active ?? true, source: 'csv_import', createdAt: now, updatedAt: now };
}

function mergeExisting(existing: Player, row: PlayerCsvRow): PlayerImportOperation {
    const player = structuredClone(existing);
    const changes: string[] = [];
    const aliases = new Map(player.aliases.map((alias) => [normalizePlayerValue(alias), alias]));
    if (normalizePlayerValue(row.displayName) !== normalizePlayerValue(player.displayName) && !aliases.has(normalizePlayerValue(row.displayName))) {
        aliases.set(normalizePlayerValue(row.displayName), row.displayName); changes.push('alias');
    }
    for (const alias of row.aliases ?? []) if (normalizePlayerValue(alias) !== normalizePlayerValue(player.displayName) && !aliases.has(normalizePlayerValue(alias))) { aliases.set(normalizePlayerValue(alias), alias); changes.push('alias'); }
    player.aliases = [...aliases.values()];
    if (player.telegramUserId === undefined && row.telegramUserId !== undefined) { player.telegramUserId = row.telegramUserId; changes.push('telegramUserId'); }
    if (!player.username && row.telegramUsername) { player.username = row.telegramUsername; changes.push('telegramUsername'); }
    if (row.confirmed !== undefined && player.isConfirmed !== row.confirmed) { player.isConfirmed = row.confirmed; changes.push('confirmed'); }
    if (row.active !== undefined && player.isActive !== row.active) { player.isActive = row.active; changes.push('active'); }
    if (changes.length) player.updatedAt = new Date().toISOString();
    return { kind: changes.length ? 'update' : 'unchanged', rowNumber: row.rowNumber, player, changes: [...new Set(changes)] };
}

function summarize(base: Omit<PlayerImportPlan, 'newCount' | 'updateCount' | 'unchangedCount' | 'conflictCount' | 'errorCount' | 'blockedCount' | 'canCommit'>): PlayerImportPlan {
    const conflictCount = base.conflicts.length; const errorCount = base.errors.length;
    return { ...base,
        newCount: base.operations.filter((item) => item.kind === 'create').length,
        updateCount: base.operations.filter((item) => item.kind === 'update').length,
        unchangedCount: base.operations.filter((item) => item.kind === 'unchanged').length,
        conflictCount, errorCount, blockedCount: conflictCount + errorCount, canCommit: conflictCount === 0 && errorCount === 0 };
}

function fingerprint(players: Player[]): string { return JSON.stringify(players.map((player) => [player.id, player.updatedAt]).sort()); }
function withCandidateIds(conflict: PlayerImportConflict, ids?: Readonly<Record<number, string>>): PlayerImportConflict { const importCandidateIds = conflict.rows.flatMap((row) => ids?.[row] ? [ids[row]] : []); return importCandidateIds.length ? { ...conflict, importCandidateIds } : conflict; }
function withOperationCandidateId(operation: PlayerImportOperation, ids?: Readonly<Record<number, string>>): PlayerImportOperation { const importCandidateId = ids?.[operation.rowNumber]; return importCandidateId ? { ...operation, importCandidateId } : operation; }
