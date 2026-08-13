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
    reviewCandidates: TelegramReviewSource[];
    state: 'preview' | 'reviewing' | 'ready' | 'committing' | 'completed' | 'cancelled' | 'expired' | 'failed'; createdAt: string; expiresAt: string;
};
export type TelegramImportCandidate = { token: string; candidate: TelegramPlayerCandidate };
export type TelegramReviewSource = TelegramImportCandidate & { type: 'POSSIBLE_DUPLICATE' | 'NEEDS_REVIEW'; candidatePlayerIds: string[] };
export type TelegramImportDecision = { type: 'merge_existing'; existingPlayerId: string } | { type: 'create_new' } | { type: 'skip' } | { type: 'rename_and_create'; displayName: string };
export type TelegramAmbiguousReview = { candidateToken: string; position: number; total: number; telegramUsername?: string; telegramDisplayName: string; suggestedDisplayName: string; players: Array<{ token: string; id: string; displayName: string }> };
export type TelegramReviewItem = TelegramAmbiguousReview & { type: 'AMBIGUOUS_MATCH' | 'POSSIBLE_DUPLICATE' | 'NEEDS_REVIEW'; remaining: number };

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
        const exactNames = new Map<string, string[]>(); for (const player of existing) for (const value of [player.displayName, ...player.aliases]) { const key = normalizePlayerValue(value); exactNames.set(key, [...new Set([...(exactNames.get(key) ?? []), player.id])]); }
        let existingCount = 0, possibleDuplicateCount = 0, reviewCount = 0;
        const reviewCandidates: TelegramReviewSource[] = [];
        const ready = built.candidates.filter((candidate) => {
            if (byTelegram.has(candidate.telegramUserId)) { existingCount++; return false; }
            if (candidate.needsReview) { reviewCount++; reviewCandidates.push({ token: token(), candidate, type: 'NEEDS_REVIEW', candidatePlayerIds: [] }); return false; }
            const matches = exactNames.get(normalizePlayerValue(candidate.suggestedDisplayName)) ?? [];
            if (matches.length === 1) { possibleDuplicateCount++; reviewCandidates.push({ token: token(), candidate, type: 'POSSIBLE_DUPLICATE', candidatePlayerIds: matches }); return false; }
            return true;
        });
        const importCandidates = ready.map((candidate) => ({ token: token(), candidate }));
        const plan = await this.buildPlan(importCandidates, {}); const now = Date.now(); const id = token();
        const summary = importReadiness(plan, possibleDuplicateCount, reviewCount);
        const session: TelegramPlayerImportSession = { id, clubId: this.clubId, requestedBy, connectionId: source.connectionId, importSourceId: source.id, candidates: built.candidates, importCandidates, reviewCandidates, decisions: {}, plan, existingCount, possibleDuplicateCount, reviewCount, skippedCount: built.botCount + built.deletedCount, partial: raw.partial, ...summary, state: summary.canCommit ? 'ready' : 'preview', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() };
        logger.info('telegram_import.scan_completed', { clubId: this.clubId, connectionId: source.connectionId, chatId: source.telegramChatId, participantCount: built.receivedCount, candidateCount: built.candidates.length, partial: raw.partial });
        this.sessions.set(id, session); logger.info('telegram_import.preview_created', { clubId: this.clubId, importSessionId: id, ...safePlanSummary(session) }); return structuredClone(session);
    }

    get(id: string, clubId: string, requestedBy: number): TelegramPlayerImportSession { this.expire(); const value = this.sessions.get(id); if (!value || value.clubId !== clubId || value.requestedBy !== requestedBy) throw new Error('TELEGRAM_IMPORT_SESSION_STALE'); if (value.state === 'expired') throw new Error('IMPORT_SESSION_EXPIRED'); if (value.state === 'cancelled') throw new Error('STALE_CALLBACK'); return structuredClone(value); }
    async commit(id: string, clubId: string, requestedBy: number): Promise<{ created: number; updated: number; unchanged: number }> {
        let session = this.get(id, clubId, requestedBy); if (session.state === 'completed') throw new Error('IMPORT_ALREADY_COMPLETED'); if (session.state === 'committing') throw new Error('IMPORT_ALREADY_COMMITTING'); if (session.state !== 'ready') throw new Error('IMPORT_PLAN_BLOCKED');
        session = await this.rebuild(session); this.sessions.set(id, session);
        if (!session.canCommit) { logger.warn('telegram_import.commit_blocked', { clubId, importSessionId: id, ...safePlanSummary(session) }); throw new Error('IMPORT_PLAN_BLOCKED'); }
        this.sessions.set(id, { ...session, state: 'committing' });
        try { const result = await this.imports.commit(session.plan); this.sessions.set(id, { ...session, state: 'completed' }); logger.info('telegram_import.completed', { clubId, importSessionId: id, ...result }); return result; }
        catch (error) {
            if (error instanceof Error && error.message === 'IMPORT_PLAN_STALE') {
                const rebuilt = await this.rebuild({ ...session, state: 'reviewing' });
                this.sessions.set(id, rebuilt);
            } else this.sessions.set(id, { ...session, state: 'failed' });
            throw error;
        }
    }
    async skipProblematic(id: string, clubId: string, requestedBy: number): Promise<TelegramPlayerImportSession> {
        const session = this.get(id, clubId, requestedBy);
        if (session.state !== 'preview' && session.state !== 'reviewing') throw new Error('TELEGRAM_IMPORT_SESSION_STALE');
        const unresolved = session.reviewCandidates.filter((item) => !session.decisions[item.token]); const skipped = unresolved.length;
        const decisions = { ...session.decisions }; for (const item of unresolved) decisions[item.token] = { type: 'skip' };
        const plan = await this.buildPlan(session.importCandidates, decisions, session.reviewCandidates);
        const summary = importReadiness(plan, 0, 0);
        const updated: TelegramPlayerImportSession = { ...session, decisions, plan, possibleDuplicateCount: 0, reviewCount: 0, skippedCount: session.skippedCount + skipped, ...summary, state: summary.canCommit ? 'ready' : 'reviewing' };
        this.sessions.set(id, updated);
        logger.info('telegram_import.review_updated', { clubId, importSessionId: id, action: 'skip_problematic', ...safePlanSummary(updated) });
        return structuredClone(updated);
    }
    async getNextReview(id: string, clubId: string, requestedBy: number): Promise<TelegramReviewItem | undefined> {
        const session = this.get(id, clubId, requestedBy); const ambiguous = await this.getNextAmbiguous(id, clubId, requestedBy);
        if (ambiguous) return { ...ambiguous, type: 'AMBIGUOUS_MATCH', remaining: session.blockedCount };
        const source = session.reviewCandidates.find((item) => item.type === 'POSSIBLE_DUPLICATE' && !session.decisions[item.token]) ?? session.reviewCandidates.find((item) => !session.decisions[item.token]); if (!source) return undefined;
        const players = await this.players.list(); const choices = source.candidatePlayerIds.flatMap((playerId) => { const player = players.find((value) => value.id === playerId); return player ? [{ token: playerToken(player.id), id: player.id, displayName: player.displayName }] : []; });
        return { type: source.type, candidateToken: source.token, position: Object.keys(session.decisions).length + 1, total: Object.keys(session.decisions).length + session.blockedCount, remaining: session.blockedCount, telegramUsername: source.candidate.telegramUsername, telegramDisplayName: source.candidate.telegramDisplayName, suggestedDisplayName: source.candidate.suggestedDisplayName, players: choices };
    }
    async resolveReview(id: string, clubId: string, requestedBy: number, candidateToken: string, decision: TelegramImportDecision): Promise<TelegramPlayerImportSession> {
        const session = this.get(id, clubId, requestedBy); const source = session.reviewCandidates.find((item) => item.token === candidateToken);
        if (!source) return this.resolveAmbiguous(id, clubId, requestedBy, candidateToken, decision);
        if (session.decisions[candidateToken]) throw new Error('CANDIDATE_ALREADY_RESOLVED');
        if (decision.type === 'merge_existing' && !source.candidatePlayerIds.includes(decision.existingPlayerId)) throw new Error('TELEGRAM_IMPORT_REVIEW_STALE');
        const decisions = { ...session.decisions, [candidateToken]: decision }; const rebuilt = await this.rebuild({ ...session, decisions }); this.sessions.set(id, rebuilt);
        logger.info('telegram_import.review_updated', { clubId, importSessionId: id, candidateToken, decisionType: decision.type, remainingBlockedCount: rebuilt.blockedCount, blockingTypes: rebuilt.blockingTypes, canCommit: rebuilt.canCommit }); return structuredClone(rebuilt);
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
        const decisions = { ...session.decisions, [candidateToken]: decision }; const updated = await this.rebuild({ ...session, decisions }); this.sessions.set(id, updated);
        logger.info('telegram_import.review_updated', { clubId, importSessionId: id, candidateToken, decisionType: decision.type, remainingBlockedCount: updated.blockedCount, blockingTypes: updated.blockingTypes, canCommit: updated.canCommit });
        return structuredClone(updated);
    }
    resolvePlayerToken(id: string, clubId: string, requestedBy: number, candidateToken: string, tokenValue: string): string {
        const session = this.get(id, clubId, requestedBy); const conflict = ambiguousConflicts(session.plan).find((value) => session.importCandidates[value.rows[0] - 2]?.token === candidateToken); const source = session.reviewCandidates.find((item) => item.token === candidateToken);
        const playerId = [...(conflict?.candidatePlayerIds ?? []), ...(source?.candidatePlayerIds ?? [])].find((value) => playerToken(value) === tokenValue); if (!playerId) throw new Error('TELEGRAM_IMPORT_REVIEW_STALE'); return playerId;
    }
    cancel(id: string, clubId: string, requestedBy: number): void { const session = this.get(id, clubId, requestedBy); this.sessions.set(id, { ...session, state: 'cancelled' }); logger.info('telegram_import.cancelled', { clubId, importSessionId: id }); }
    private expire(): void { const now = Date.now(); for (const [id, session] of this.sessions) if (new Date(session.expiresAt).getTime() <= now && session.state !== 'completed') this.sessions.set(id, { ...session, state: 'expired' }); }
    private async rebuild(session: TelegramPlayerImportSession): Promise<TelegramPlayerImportSession> {
        const plan = await this.buildPlan(session.importCandidates, session.decisions, session.reviewCandidates);
        const unresolved = session.reviewCandidates.filter((item) => !session.decisions[item.token]); const possibleDuplicateCount = unresolved.filter((item) => item.type === 'POSSIBLE_DUPLICATE').length; const reviewCount = unresolved.filter((item) => item.type === 'NEEDS_REVIEW').length;
        const summary = importReadiness(plan, possibleDuplicateCount, reviewCount); const state = summary.canCommit ? 'ready' : 'reviewing'; const rebuilt = { ...session, plan, possibleDuplicateCount, reviewCount, ...summary, state } as TelegramPlayerImportSession;
        logger.info('telegram_import.plan_rebuilt', { clubId: session.clubId, importSessionId: session.id, ...safePlanSummary(rebuilt) }); return rebuilt;
    }
    private async buildPlan(items: readonly TelegramImportCandidate[], decisions: Readonly<Record<string, TelegramImportDecision>>, reviewItems: readonly TelegramReviewSource[] = []): Promise<PlayerImportPlan> {
        const resolved = reviewItems.filter((item) => { const decision = decisions[item.token]; return decision && decision.type !== 'skip'; }); const planned = [...items, ...resolved];
        const csv = ['displayName,telegramUserId,telegramUsername,aliases,confirmed,active', ...planned.map((item) => { const decision = decisions[item.token]; const name = decision?.type === 'rename_and_create' ? decision.displayName : item.candidate.suggestedDisplayName; return [name, item.candidate.telegramUserId, item.candidate.telegramUsername, item.candidate.aliases.join('|'), true, true].map(escapeCsv).join(','); })].join('\n');
        const rowResolutions: Record<number, PlayerImportRowResolution> = {}; const skippedRows: number[] = [];
        planned.forEach((item, index) => { const row = index + 2; const decision = decisions[item.token]; if (decision?.type === 'merge_existing') rowResolutions[row] = { kind: 'existing', playerId: decision.existingPlayerId }; else if (decision?.type === 'create_new' || decision?.type === 'rename_and_create') rowResolutions[row] = { kind: 'create' }; else if (decision?.type === 'skip') skippedRows.push(row); });
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

export type TelegramImportUiState = { lifecycle: TelegramPlayerImportSession['state']; canCommit: boolean; hasWork: boolean; unresolvedCount: number; skippableCount: number; availableActions: Array<'review' | 'skip_problematic' | 'commit' | 'cancel'> };
export function getImportUiState(session: TelegramPlayerImportSession): TelegramImportUiState {
    const hasWork = session.plan.newCount + session.plan.updateCount > 0; const skippableCount = session.possibleDuplicateCount + session.reviewCount; const actions: TelegramImportUiState['availableActions'] = [];
    const resolvableCount = skippableCount + ambiguousConflicts(session.plan).length;
    if (resolvableCount > 0) actions.push('review'); if (skippableCount > 0) actions.push('skip_problematic'); if (session.canCommit && hasWork && session.state === 'ready') actions.push('commit'); actions.push('cancel');
    return { lifecycle: session.state, canCommit: session.canCommit, hasWork, unresolvedCount: session.blockedCount, skippableCount, availableActions: actions };
}
