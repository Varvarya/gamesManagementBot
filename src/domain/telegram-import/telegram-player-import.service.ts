import { createHash, randomBytes } from 'node:crypto';
import { PlayerImportPlan, PlayerImportRowResolution, PlayerImportService } from '../players/player-import.service';
import { PlayersRepository } from '../../storage/repositories/players.repository';
import { normalizePlayerValue, escapeCsv } from '../players/player-csv';
import { TelegramUserConnectionManager } from './telegram-user-connection.manager';
import { TelegramPlayerCandidate, TelegramPlayerCandidateBuilder } from '../../tools/telegram-players-export/telegram-player-candidate';
import { TelegramImportSource } from './telegram-user-connection.types';
import { logger } from '../../utils/logger';

export type TelegramPlayerImportSession = {
    id: string; clubId: string; requestedBy: number; connectionId: string; importSourceId: string;
    candidates: TelegramPlayerCandidate[]; plan: PlayerImportPlan; existingCount: number; possibleDuplicateCount: number; reviewCount: number; skippedCount: number; partial: boolean;
    blockedCount: number; canCommit: boolean; blockingTypes: TelegramImportBlockingType[];
    importCandidates: TelegramImportCandidate[]; decisions: Record<string, TelegramImportDecision>;
    state: 'preview' | 'reviewing' | 'committing' | 'completed' | 'cancelled' | 'expired'; createdAt: string; expiresAt: string;
};
export type TelegramImportCandidate = { token: string; candidate: TelegramPlayerCandidate };
export type TelegramImportDecision = { type: 'merge_existing'; existingPlayerId: string } | { type: 'create_new' } | { type: 'skip' };
export type TelegramAmbiguousReview = { candidateToken: string; position: number; total: number; telegramUsername?: string; telegramDisplayName: string; suggestedDisplayName: string; players: Array<{ token: string; id: string; displayName: string }> };

export type TelegramImportBlockingType = 'POSSIBLE_DUPLICATE' | 'NEEDS_REVIEW' | 'AMBIGUOUS_MATCH' | 'DUPLICATE_TELEGRAM_ID' | 'INVALID_PLAYER';

export class TelegramPlayerImportService {
    private readonly sessions = new Map<string, TelegramPlayerImportSession>();
    private readonly imports: PlayerImportService;
    constructor(private readonly clubId: string, private readonly players: PlayersRepository, private readonly manager: Pick<TelegramUserConnectionManager, 'scan'>, createBackup: () => Promise<unknown>) { this.imports = new PlayerImportService(clubId, players, createBackup); }

    async scan(source: TelegramImportSource, requestedBy: number): Promise<TelegramPlayerImportSession> {
        if (source.clubId !== this.clubId) throw new Error('CLUB_CONTEXT_MISMATCH'); this.expire();
        logger.info('telegram_import.scan_started', { clubId: this.clubId, connectionId: source.connectionId, chatId: source.telegramChatId });
        const raw = await this.manager.scan(source, this.clubId); const built = new TelegramPlayerCandidateBuilder().build(raw.participants, raw.contacts); const existing = await this.players.list();
        const byTelegram = new Set(existing.flatMap((player) => player.telegramUserId === undefined ? [] : [Number(player.telegramUserId)]));
        const exactNames = new Map<string, number>(); for (const player of existing) for (const value of [player.displayName, ...player.aliases]) exactNames.set(normalizePlayerValue(value), (exactNames.get(normalizePlayerValue(value)) ?? 0) + 1);
        let existingCount = 0, possibleDuplicateCount = 0, reviewCount = 0;
        const ready = built.candidates.filter((candidate) => {
            if (byTelegram.has(candidate.telegramUserId)) { existingCount++; return false; }
            if (candidate.needsReview) { reviewCount++; return false; }
            if (exactNames.get(normalizePlayerValue(candidate.suggestedDisplayName)) === 1) { possibleDuplicateCount++; return false; }
            return true;
        });
        const importCandidates = ready.map((candidate) => ({ token: token(), candidate }));
        const plan = await this.buildPlan(importCandidates, {}); const now = Date.now(); const id = token();
        const summary = importReadiness(plan, possibleDuplicateCount, reviewCount);
        const session: TelegramPlayerImportSession = { id, clubId: this.clubId, requestedBy, connectionId: source.connectionId, importSourceId: source.id, candidates: built.candidates, importCandidates, decisions: {}, plan, existingCount, possibleDuplicateCount, reviewCount, skippedCount: built.botCount + built.deletedCount, partial: raw.partial, ...summary, state: 'preview', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() };
        logger.info('telegram_import.scan_completed', { clubId: this.clubId, connectionId: source.connectionId, chatId: source.telegramChatId, participantCount: built.receivedCount, candidateCount: built.candidates.length, partial: raw.partial });
        this.sessions.set(id, session); logger.info('telegram_import.preview_created', { clubId: this.clubId, importSessionId: id, ...safePlanSummary(session) }); return structuredClone(session);
    }

    get(id: string, clubId: string, requestedBy: number): TelegramPlayerImportSession { this.expire(); const value = this.sessions.get(id); if (!value || value.clubId !== clubId || value.requestedBy !== requestedBy) throw new Error('TELEGRAM_IMPORT_SESSION_STALE'); return structuredClone(value); }
    async commit(id: string, clubId: string, requestedBy: number): Promise<{ created: number; updated: number; unchanged: number }> {
        let session = this.get(id, clubId, requestedBy); if (session.state === 'completed') return { created: 0, updated: 0, unchanged: session.plan.operations.length }; if (session.state !== 'preview' && session.state !== 'reviewing') throw new Error('TELEGRAM_IMPORT_ALREADY_COMMITTING');
        const plan = await this.buildPlan(session.importCandidates, session.decisions); const readiness = importReadiness(plan, session.possibleDuplicateCount, session.reviewCount); session = { ...session, plan, ...readiness, state: 'preview' }; this.sessions.set(id, session);
        if (!session.canCommit) { logger.warn('telegram_import.commit_blocked', { clubId, importSessionId: id, ...safePlanSummary(session) }); throw new Error('IMPORT_PLAN_BLOCKED'); }
        this.sessions.set(id, { ...session, state: 'committing' });
        try { const result = await this.imports.commit(session.plan); this.sessions.set(id, { ...session, state: 'completed' }); logger.info('telegram_import.completed', { clubId, importSessionId: id, ...result }); return result; }
        catch (error) { this.sessions.set(id, session); throw error; }
    }
    async skipProblematic(id: string, clubId: string, requestedBy: number): Promise<TelegramPlayerImportSession> {
        const session = this.get(id, clubId, requestedBy);
        if (session.state !== 'preview' && session.state !== 'reviewing') throw new Error('TELEGRAM_IMPORT_SESSION_STALE');
        const skipped = session.possibleDuplicateCount + session.reviewCount;
        const plan = await this.buildPlan(session.importCandidates, session.decisions);
        const summary = importReadiness(plan, 0, 0);
        const updated: TelegramPlayerImportSession = { ...session, plan, possibleDuplicateCount: 0, reviewCount: 0, skippedCount: session.skippedCount + skipped, ...summary, state: 'preview' };
        this.sessions.set(id, updated);
        logger.info('telegram_import.review_updated', { clubId, importSessionId: id, action: 'skip_problematic', ...safePlanSummary(updated) });
        return structuredClone(updated);
    }
    async getNextAmbiguous(id: string, clubId: string, requestedBy: number): Promise<TelegramAmbiguousReview | undefined> {
        const session = this.get(id, clubId, requestedBy); const conflicts = ambiguousConflicts(session.plan);
        if (!conflicts.length) return undefined;
        const conflict = conflicts[0]; const row = conflict.rows[0]; const item = session.importCandidates[row - 2];
        if (!item) throw new Error('TELEGRAM_IMPORT_REVIEW_STALE');
        const players = await this.players.list(); const choices = (conflict.candidatePlayerIds ?? []).flatMap((playerId) => { const player = players.find((value) => value.id === playerId); return player ? [{ token: playerToken(player.id), id: player.id, displayName: player.displayName }] : []; });
        return { candidateToken: item.token, position: resolvedAmbiguousCount(session) + 1, total: resolvedAmbiguousCount(session) + conflicts.length, telegramUsername: item.candidate.telegramUsername, telegramDisplayName: item.candidate.telegramDisplayName, suggestedDisplayName: item.candidate.suggestedDisplayName, players: choices };
    }
    async resolveAmbiguous(id: string, clubId: string, requestedBy: number, candidateToken: string, decision: TelegramImportDecision): Promise<TelegramPlayerImportSession> {
        const session = this.get(id, clubId, requestedBy); const item = session.importCandidates.find((value) => value.token === candidateToken); if (!item) throw new Error('TELEGRAM_IMPORT_REVIEW_STALE');
        if (decision.type === 'merge_existing' && !(await this.players.list()).some((player) => player.id === decision.existingPlayerId)) throw new Error('TELEGRAM_IMPORT_REVIEW_STALE');
        const decisions = { ...session.decisions, [candidateToken]: decision }; const plan = await this.buildPlan(session.importCandidates, decisions); const summary = importReadiness(plan, session.possibleDuplicateCount, session.reviewCount);
        const updated = { ...session, decisions, plan, ...summary, state: (summary.canCommit ? 'preview' : 'reviewing') as 'preview' | 'reviewing' }; this.sessions.set(id, updated);
        logger.info('telegram_import.review_updated', { clubId, importSessionId: id, candidateToken, decisionType: decision.type, remainingBlockedCount: updated.blockedCount, blockingTypes: updated.blockingTypes, canCommit: updated.canCommit });
        return structuredClone(updated);
    }
    resolvePlayerToken(id: string, clubId: string, requestedBy: number, candidateToken: string, tokenValue: string): string {
        const session = this.get(id, clubId, requestedBy); const conflict = ambiguousConflicts(session.plan).find((value) => session.importCandidates[value.rows[0] - 2]?.token === candidateToken);
        const playerId = conflict?.candidatePlayerIds?.find((value) => playerToken(value) === tokenValue); if (!playerId) throw new Error('TELEGRAM_IMPORT_REVIEW_STALE'); return playerId;
    }
    cancel(id: string, clubId: string, requestedBy: number): void { const session = this.get(id, clubId, requestedBy); this.sessions.set(id, { ...session, state: 'cancelled' }); }
    private expire(): void { const now = Date.now(); for (const [id, session] of this.sessions) if (new Date(session.expiresAt).getTime() <= now && session.state !== 'completed') this.sessions.set(id, { ...session, state: 'expired' }); }
    private async buildPlan(items: readonly TelegramImportCandidate[], decisions: Readonly<Record<string, TelegramImportDecision>>): Promise<PlayerImportPlan> {
        const csv = ['displayName,telegramUserId,telegramUsername,aliases,confirmed,active', ...items.map((item) => [item.candidate.suggestedDisplayName, item.candidate.telegramUserId, item.candidate.telegramUsername, item.candidate.aliases.join('|'), true, true].map(escapeCsv).join(','))].join('\n');
        const rowResolutions: Record<number, PlayerImportRowResolution> = {}; const skippedRows: number[] = [];
        items.forEach((item, index) => { const row = index + 2; const decision = decisions[item.token]; if (decision?.type === 'merge_existing') rowResolutions[row] = { kind: 'existing', playerId: decision.existingPlayerId }; else if (decision?.type === 'create_new') rowResolutions[row] = { kind: 'create' }; else if (decision?.type === 'skip') skippedRows.push(row); });
        return this.imports.preview(csv, { rowResolutions, skippedRows });
    }
}

function ambiguousConflicts(plan: PlayerImportPlan) { return plan.conflicts.filter((conflict) => conflict.type === 'ambiguous_exact_match' && conflict.candidatePlayerIds?.length); }
function resolvedAmbiguousCount(session: TelegramPlayerImportSession): number { return Object.values(session.decisions).length; }
function token(): string { return randomBytes(6).toString('base64url'); }
function playerToken(playerId: string): string { return createHash('sha256').update(playerId).digest('base64url').slice(0, 10); }

function importReadiness(plan: PlayerImportPlan, possibleDuplicateCount: number, reviewCount: number): Pick<TelegramPlayerImportSession, 'blockedCount' | 'canCommit' | 'blockingTypes'> {
    const blockingTypes = new Set<TelegramImportBlockingType>();
    if (possibleDuplicateCount) blockingTypes.add('POSSIBLE_DUPLICATE');
    if (reviewCount) blockingTypes.add('NEEDS_REVIEW');
    for (const conflict of plan.conflicts) {
        if (conflict.type === 'csv_telegram_duplicate') blockingTypes.add('DUPLICATE_TELEGRAM_ID');
        else blockingTypes.add('AMBIGUOUS_MATCH');
    }
    if (plan.errors.length) blockingTypes.add('INVALID_PLAYER');
    const blockedCount = possibleDuplicateCount + reviewCount + plan.blockedCount;
    return { blockedCount, canCommit: blockedCount === 0 && plan.canCommit, blockingTypes: [...blockingTypes] };
}

export function safePlanSummary(session: TelegramPlayerImportSession) {
    return { total: session.candidates.length, newCount: session.plan.newCount, updateCount: session.plan.updateCount, unchangedCount: session.plan.unchangedCount,
        conflictCount: session.plan.conflictCount, errorCount: session.plan.errorCount, blockedCount: session.blockedCount, canCommit: session.canCommit, blockingTypes: session.blockingTypes };
}
