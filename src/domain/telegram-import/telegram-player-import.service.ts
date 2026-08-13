import { randomBytes } from 'node:crypto';
import { PlayerImportPlan, PlayerImportService } from '../players/player-import.service';
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
    state: 'preview' | 'reviewing' | 'committing' | 'completed' | 'cancelled' | 'expired'; createdAt: string; expiresAt: string;
};

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
            if (exactNames.has(normalizePlayerValue(candidate.suggestedDisplayName))) { possibleDuplicateCount++; return false; }
            return true;
        });
        const csv = ['displayName,telegramUserId,telegramUsername,aliases,confirmed,active', ...ready.map((item) => [item.suggestedDisplayName, item.telegramUserId, item.telegramUsername, item.aliases.join('|'), true, true].map(escapeCsv).join(','))].join('\n');
        const plan = await this.imports.preview(csv); const now = Date.now(); const id = randomBytes(6).toString('base64url');
        const summary = importReadiness(plan, possibleDuplicateCount, reviewCount);
        const session: TelegramPlayerImportSession = { id, clubId: this.clubId, requestedBy, connectionId: source.connectionId, importSourceId: source.id, candidates: built.candidates, plan, existingCount, possibleDuplicateCount, reviewCount, skippedCount: built.botCount + built.deletedCount, partial: raw.partial, ...summary, state: 'preview', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() };
        logger.info('telegram_import.scan_completed', { clubId: this.clubId, connectionId: source.connectionId, chatId: source.telegramChatId, participantCount: built.receivedCount, candidateCount: built.candidates.length, partial: raw.partial });
        this.sessions.set(id, session); logger.info('telegram_import.preview_created', { clubId: this.clubId, importSessionId: id, ...safePlanSummary(session) }); return structuredClone(session);
    }

    get(id: string, clubId: string, requestedBy: number): TelegramPlayerImportSession { this.expire(); const value = this.sessions.get(id); if (!value || value.clubId !== clubId || value.requestedBy !== requestedBy) throw new Error('TELEGRAM_IMPORT_SESSION_STALE'); return structuredClone(value); }
    async commit(id: string, clubId: string, requestedBy: number): Promise<{ created: number; updated: number; unchanged: number }> {
        const session = this.get(id, clubId, requestedBy); if (session.state === 'completed') return { created: 0, updated: 0, unchanged: session.plan.operations.length }; if (session.state !== 'preview') throw new Error('TELEGRAM_IMPORT_ALREADY_COMMITTING');
        if (!session.canCommit) { logger.warn('telegram_import.commit_blocked', { clubId, importSessionId: id, ...safePlanSummary(session) }); throw new Error('IMPORT_PLAN_BLOCKED'); }
        this.sessions.set(id, { ...session, state: 'committing' });
        try { const result = await this.imports.commit(session.plan); this.sessions.set(id, { ...session, state: 'completed' }); logger.info('telegram_import.completed', { clubId, importSessionId: id, ...result }); return result; }
        catch (error) { this.sessions.set(id, session); throw error; }
    }
    skipProblematic(id: string, clubId: string, requestedBy: number): TelegramPlayerImportSession {
        const session = this.get(id, clubId, requestedBy);
        if (session.state !== 'preview' && session.state !== 'reviewing') throw new Error('TELEGRAM_IMPORT_SESSION_STALE');
        const skipped = session.possibleDuplicateCount + session.reviewCount;
        const summary = importReadiness(session.plan, 0, 0);
        const updated: TelegramPlayerImportSession = { ...session, possibleDuplicateCount: 0, reviewCount: 0, skippedCount: session.skippedCount + skipped, ...summary, state: 'preview' };
        this.sessions.set(id, updated);
        logger.info('telegram_import.review_updated', { clubId, importSessionId: id, action: 'skip_problematic', ...safePlanSummary(updated) });
        return structuredClone(updated);
    }
    cancel(id: string, clubId: string, requestedBy: number): void { const session = this.get(id, clubId, requestedBy); this.sessions.set(id, { ...session, state: 'cancelled' }); }
    private expire(): void { const now = Date.now(); for (const [id, session] of this.sessions) if (new Date(session.expiresAt).getTime() <= now && session.state !== 'completed') this.sessions.set(id, { ...session, state: 'expired' }); }
}

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
