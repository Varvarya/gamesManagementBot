import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { TelegramClient } from 'teleproto';
import { logger } from '../../utils/logger';
import { TelegramUserConnectionManager } from './telegram-user-connection.manager';
import { TelegramUserConnection } from './telegram-user-connection.types';
import { classifyTelegramAuthError, safeTelegramErrorDetails, TelegramAuthError } from './telegram-auth-error';

export type TelegramQrAuthStatus = 'waiting_scan' | 'authorizing' | 'password_required' | 'completed' | 'cancelled' | 'expired' | 'failed';
export type TelegramQrFailureReason = 'QR_TOKEN_EXPIRED' | 'QR_TOKEN_INVALID' | 'QR_AUTH_CANCELLED' | 'AUTH_ACCOUNT_MISMATCH' | 'SESSION_PASSWORD_NEEDED' | 'PASSWORD_INVALID' | 'FLOOD_WAIT' | 'NETWORK_ERROR' | 'SESSION_ENCRYPTION_FAILED' | 'SESSION_PERSIST_FAILED' | 'UNKNOWN';
export type TelegramQrPresentation = { id: string; png: Buffer; expiresAt: string; status: TelegramQrAuthStatus };
export type TelegramQrAuthEvents = {
    onQr?(value: TelegramQrPresentation): Promise<void> | void;
    onPasswordRequired?(attemptId: string): Promise<void> | void;
    onPasswordInvalid?(attemptId: string): Promise<void> | void;
    onCompleted?(attemptId: string, connection: TelegramUserConnection): Promise<void> | void;
    onExpired?(attemptId: string): Promise<void> | void;
    onFailed?(attemptId: string, reason: TelegramQrFailureReason): Promise<void> | void;
};
type PasswordWaiter = { promise: Promise<string>; resolve(value: string): void };
type Attempt = { id: string; clubId: string; requestedByTelegramUserId: number; client: TelegramClient; abort: AbortController; createdAt: number; expiresAt: number; status: TelegramQrAuthStatus; password: PasswordWaiter; events: TelegramQrAuthEvents; firstQr: Promise<TelegramQrPresentation>; resolveFirstQr(value: TelegramQrPresentation): void; failure?: TelegramQrFailureReason; expiryTimer?: ReturnType<typeof setTimeout> };

type QrConnectionManager = Pick<TelegramUserConnectionManager, 'createQrAuthClient' | 'getQrApiCredentials' | 'persistAuthenticatedClient'>;
export class TelegramQrAuthService {
    private readonly attempts = new Map<string, Attempt>();
    private readonly byOwner = new Map<string, string>();
    constructor(private readonly connections: QrConnectionManager, private readonly now: () => number = Date.now, private readonly ttlMs = 10 * 60_000) {}

    async startQrLogin(clubId: string, requestedByTelegramUserId: number, events: TelegramQrAuthEvents = {}): Promise<TelegramQrPresentation> {
        await this.cancelFor(clubId, requestedByTelegramUserId);
        const client = this.connections.createQrAuthClient(); const abort = new AbortController(); const id = randomBytes(6).toString('base64url');
        let resolveFirstQr!: (value: TelegramQrPresentation) => void;
        const firstQr = new Promise<TelegramQrPresentation>((resolve) => { resolveFirstQr = resolve; });
        const attempt: Attempt = { id, clubId, requestedByTelegramUserId, client, abort, createdAt: this.now(), expiresAt: this.now() + this.ttlMs, status: 'waiting_scan', password: deferred(), events, firstQr, resolveFirstQr };
        this.attempts.set(id, attempt); this.byOwner.set(ownerKey(clubId, requestedByTelegramUserId), id);
        attempt.expiryTimer = setTimeout(() => { void this.expireAttempt(attempt); }, this.ttlMs);
        logger.info('telegram_qr_auth.started', fields(attempt));
        void this.run(attempt);
        return firstQr;
    }

    async refreshQrLogin(attemptId: string, clubId: string, requestedBy: number, events?: TelegramQrAuthEvents): Promise<TelegramQrPresentation> {
        const old = this.attempts.get(attemptId); const callbacks = events ?? old?.events ?? {}; if (old && old.clubId === clubId && old.requestedByTelegramUserId === requestedBy) await this.cancel(attemptId, clubId, requestedBy, false); return this.startQrLogin(clubId, requestedBy, callbacks);
    }
    async submitPassword(attemptId: string, clubId: string, requestedBy: number, password: string): Promise<void> { const attempt = this.requireAttempt(attemptId, clubId, requestedBy); if (attempt.status !== 'password_required') throw new TelegramQrAuthError('QR_TOKEN_INVALID', 'password_not_expected'); attempt.password.resolve(password); }
    async cancel(attemptId: string, clubId: string, requestedBy: number, notify = true): Promise<void> { const attempt = this.requireAttempt(attemptId, clubId, requestedBy); attempt.status = 'cancelled'; attempt.abort.abort(); await attempt.client.disconnect().catch(() => undefined); this.remove(attempt); if (notify) { logger.info('telegram_qr_auth.cancelled', fields(attempt)); await attempt.events.onFailed?.(attempt.id, 'QR_AUTH_CANCELLED'); } }
    get(attemptId: string, clubId: string, requestedBy: number): TelegramQrAuthStatus { this.expire(); return this.requireAttempt(attemptId, clubId, requestedBy).status; }

    private async run(attempt: Attempt): Promise<void> {
        try {
            await attempt.client.connect();
            await attempt.client.signInUserWithQrCode(this.connections.getQrApiCredentials(), {
                abortSignal: attempt.abort.signal,
                qrCode: async ({ token, expires }) => {
                    if (attempt.abort.signal.aborted) return;
                    const expiresAt = Math.min(expires * 1000, attempt.expiresAt); attempt.status = 'waiting_scan';
                    const png = await QRCode.toBuffer(`tg://login?token=${token.toString('base64url')}`, { type: 'png', width: 420, margin: 2, errorCorrectionLevel: 'M' });
                    const presentation = { id: attempt.id, png, expiresAt: new Date(expiresAt).toISOString(), status: attempt.status } as const;
                    logger.info('telegram_qr_auth.token_created', { ...fields(attempt), expiresAt: presentation.expiresAt }); attempt.resolveFirstQr(presentation); await attempt.events.onQr?.(presentation);
                },
                password: async () => { attempt.status = 'password_required'; logger.info('telegram_qr_auth.password_required', fields(attempt)); await attempt.events.onPasswordRequired?.(attempt.id); return attempt.password.promise; },
                onError: async (error) => {
                    const reason = classifyQrFailure(error); this.logFailure(attempt, reason, error);
                    if (reason === 'PASSWORD_INVALID') { attempt.password = deferred(); attempt.status = 'password_required'; await attempt.events.onPasswordInvalid?.(attempt.id); return false; }
                    attempt.failure = reason; return true;
                },
            });
            attempt.status = 'authorizing'; logger.info('telegram_qr_auth.scanned', fields(attempt));
            const connection = await this.connections.persistAuthenticatedClient(attempt.clubId, attempt.requestedByTelegramUserId, attempt.client);
            attempt.status = 'completed'; logger.info('telegram_qr_auth.completed', { ...fields(attempt), connectionId: connection.id, telegramUserId: connection.telegramUserId });
            await attempt.events.onCompleted?.(attempt.id, connection); this.remove(attempt);
        } catch (error) {
            if (attempt.status === 'cancelled' || isAbort(error)) return;
            const reason = attempt.failure ?? classifyQrFailure(error);
            if (reason === 'QR_TOKEN_EXPIRED') { attempt.status = 'expired'; logger.info('telegram_qr_auth.expired', fields(attempt)); await attempt.events.onExpired?.(attempt.id); }
            else { attempt.status = 'failed'; this.logFailure(attempt, reason, error); await attempt.events.onFailed?.(attempt.id, reason); }
            this.remove(attempt);
        } finally { await attempt.client.disconnect().catch(() => undefined); }
    }
    private requireAttempt(id: string, clubId: string, requestedBy: number): Attempt { const attempt = this.attempts.get(id); if (!attempt || attempt.clubId !== clubId || attempt.requestedByTelegramUserId !== requestedBy) throw new TelegramQrAuthError('QR_TOKEN_EXPIRED', 'stale_attempt'); if (attempt.expiresAt <= this.now()) { void this.expireAttempt(attempt); throw new TelegramQrAuthError('QR_TOKEN_EXPIRED', 'expired'); } return attempt; }
    private async cancelFor(clubId: string, requestedBy: number): Promise<void> { const id = this.byOwner.get(ownerKey(clubId, requestedBy)); const attempt = id ? this.attempts.get(id) : undefined; if (attempt) await this.cancel(attempt.id, clubId, requestedBy, false); }
    private expire(): void { for (const attempt of this.attempts.values()) if (attempt.expiresAt <= this.now()) void this.expireAttempt(attempt); }
    private async expireAttempt(attempt: Attempt): Promise<void> { attempt.status = 'expired'; attempt.abort.abort(); await attempt.client.disconnect().catch(() => undefined); logger.info('telegram_qr_auth.expired', fields(attempt)); this.remove(attempt); await attempt.events.onExpired?.(attempt.id); }
    private remove(attempt: Attempt): void { if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer); this.attempts.delete(attempt.id); if (this.byOwner.get(ownerKey(attempt.clubId, attempt.requestedByTelegramUserId)) === attempt.id) this.byOwner.delete(ownerKey(attempt.clubId, attempt.requestedByTelegramUserId)); }
    private logFailure(attempt: Attempt, reason: TelegramQrFailureReason, error: unknown): void { const detail = safeTelegramErrorDetails(error); logger.error('telegram_qr_auth.failed', { ...fields(attempt), reason, errorName: detail.name, errorMessage: detail.message, errorCode: detail.code, rpcErrorMessage: detail.errorMessage, stack: detail.stack }); }
}

export class TelegramQrAuthError extends Error { constructor(readonly reason: TelegramQrFailureReason, readonly stage: string) { super(reason); this.name = 'TelegramQrAuthError'; } }
function classifyQrFailure(error: unknown): TelegramQrFailureReason { if (error instanceof TelegramAuthError) { if (error.reason === 'SESSION_ENCRYPTION_FAILED') return 'SESSION_ENCRYPTION_FAILED'; if (error.reason === 'SESSION_PERSIST_FAILED') return 'SESSION_PERSIST_FAILED'; } const detail = safeTelegramErrorDetails(error); const value = `${detail.name} ${detail.message} ${detail.errorMessage}`.toUpperCase(); if (/AUTH_TOKEN_EXPIRED|QR_TOKEN_EXPIRED/.test(value)) return 'QR_TOKEN_EXPIRED'; if (/AUTH_TOKEN_INVALID|QR_TOKEN_INVALID/.test(value)) return 'QR_TOKEN_INVALID'; if (/AUTH_ACCOUNT_MISMATCH/.test(value)) return 'AUTH_ACCOUNT_MISMATCH'; if (/SESSION_PASSWORD_NEEDED/.test(value)) return 'SESSION_PASSWORD_NEEDED'; if (/PASSWORD_HASH_INVALID/.test(value)) return 'PASSWORD_INVALID'; if (/FLOOD_WAIT/.test(value)) return 'FLOOD_WAIT'; const classified = classifyTelegramAuthError(error); if (classified.reason === 'NETWORK_ERROR') return 'NETWORK_ERROR'; return 'UNKNOWN'; }
function isAbort(error: unknown): boolean { return error instanceof Error && (error.name === 'AbortError' || /aborted|AUTH_USER_CANCEL/i.test(error.message)); }
function ownerKey(clubId: string, userId: number): string { return `${clubId}:${userId}`; }
function fields(attempt: Attempt) { return { clubId: attempt.clubId, requestedByTelegramUserId: attempt.requestedByTelegramUserId, authAttemptId: attempt.id, stage: attempt.status }; }
function deferred(): PasswordWaiter { let resolve!: (value: string) => void; return { promise: new Promise((done) => { resolve = done; }), resolve }; }
