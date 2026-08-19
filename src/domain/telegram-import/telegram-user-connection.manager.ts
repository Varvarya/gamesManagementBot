import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { atomicWriteJson, readReliableJson } from '../../storage/atomicWrite';
import { TelegramImportSourceRepository, TelegramUserConnectionRepository } from '../../storage/repositories/telegram-user-connection.repository';
import { TelegramImportSource, TelegramUserConnection } from './telegram-user-connection.types';
import { EncryptedTelegramSession, TelegramSessionCipher } from './telegram-session-cipher';
import { TelegramContactsLoader, TelegramGroupDialog, TelegramParticipantLoader } from '../../tools/telegram-players-export/telegram-mtproto-loader';
import { TelegramContact, TelegramParticipant } from '../../tools/telegram-players-export/telegram-player-candidate';
import { createId } from '../../utils/ids';
import { logger } from '../../utils/logger';
import { classifyTelegramAuthError, isRetryableTelegramAuthFailure, normalizeTelegramCode, normalizeTelegramPhone, readTelegramMtprotoConfig, safeTelegramErrorDetails, TelegramAuthError, TelegramMtprotoConfig } from './telegram-auth-error';

export type TelegramAuthenticationStage = 'starting' | 'code' | 'password' | 'completed' | 'failed';
export type TelegramHistoryMessage = { messageId: number; date: Date; text: string; telegramUser: { id: number; first_name?: string; username?: string } };
type Deferred = { promise: Promise<string>; resolve(value: string): void };
type AuthFlow = { clubId: string; requestedBy: number; client: TelegramClient; code: Deferred; password: Deferred; stage: TelegramAuthenticationStage; stageWaiters: Array<(stage: TelegramAuthenticationStage) => void>; error?: TelegramAuthError; expiresAt: number };

export class TelegramUserConnectionManager {
    readonly configured: boolean;
    private readonly apiId: number;
    private readonly apiHash: string;
    private readonly cipher?: TelegramSessionCipher;
    private readonly sessionsDirectory: string;
    private readonly connections: TelegramUserConnectionRepository;
    private readonly sources: TelegramImportSourceRepository;
    private readonly authFlows = new Map<number, AuthFlow>();
    private readonly clientFactory: (session: StringSession) => TelegramClient;
    private readonly now: () => number;
    private readonly authTtlMs: number;

    constructor(dataDir: string, config: TelegramMtprotoConfig = readTelegramMtprotoConfig(), dependencies: { clientFactory?: (session: StringSession) => TelegramClient; now?: () => number; authTtlMs?: number } = {}) {
        const system = path.join(dataDir, '_system');
        this.apiId = config.apiId; this.apiHash = config.apiHash.trim();
        this.configured = config.valid;
        this.cipher = this.configured ? new TelegramSessionCipher(config.encryptionKey) : undefined;
        this.sessionsDirectory = path.join(system, 'telegram-sessions');
        this.connections = new TelegramUserConnectionRepository(path.join(system, 'telegram-user-connections.json'));
        this.sources = new TelegramImportSourceRepository(path.join(system, 'telegram-import-sources.json'));
        this.clientFactory = dependencies.clientFactory ?? ((session) => new TelegramClient(session, this.apiId, this.apiHash, { connectionRetries: 5 }));
        this.now = dependencies.now ?? Date.now;
        this.authTtlMs = dependencies.authTtlMs ?? 10 * 60_000;
        logger.info('telegram.mtproto_config_loaded', { apiIdPresent: config.apiIdPresent, apiHashPresent: config.apiHashPresent, encryptionKeyPresent: config.encryptionKeyPresent, apiIdValid: Number.isSafeInteger(config.apiId) && config.apiId > 0, enabled: this.configured });
    }

    async getConnections(clubId: string): Promise<TelegramUserConnection[]> { return this.connections.listByClub(clubId); }
    async getConnection(clubId: string): Promise<TelegramUserConnection | undefined> { const values = await this.getConnections(clubId); return [...values].reverse().find((item) => item.status === 'connected') ?? values.at(-1); }
    async getSources(clubId: string): Promise<TelegramImportSource[]> { return this.sources.listByClub(clubId); }
    async getSourceByShortId(clubId: string, shortId: string): Promise<TelegramImportSource | undefined> { const source = await this.sources.findByShortId(shortId); return source?.clubId === clubId ? source : undefined; }
    async cancelAuthentication(requestingAdminTelegramUserId: number): Promise<void> { const flow = this.authFlows.get(requestingAdminTelegramUserId); if (!flow) return; this.authFlows.delete(requestingAdminTelegramUserId); await flow.client.disconnect().catch(() => undefined); }
    createQrAuthClient(): TelegramClient { this.requireConfigured(); return this.clientFactory(new StringSession('')); }
    getQrApiCredentials(): { apiId: number; apiHash: string } { this.requireConfigured(); return { apiId: this.apiId, apiHash: this.apiHash }; }

    async persistAuthenticatedClient(clubId: string, requestingUserId: number, client: TelegramClient): Promise<TelegramUserConnection> {
        let user: Awaited<ReturnType<TelegramClient['getMe']>>;
        try { user = await client.getMe(); } catch (error) { throw classifyTelegramAuthError(error, 'session_validate'); }
        if (!(user instanceof Api.User)) throw new TelegramAuthError('UNKNOWN_AUTH_ERROR', 'session_validate', new Error('Authenticated Telegram identity is unavailable'));
        const telegramUserId = Number(user.id.toString());
        if (telegramUserId !== requestingUserId) throw new TelegramAuthError('UNKNOWN_AUTH_ERROR', 'account_verify', new Error('AUTH_ACCOUNT_MISMATCH'));
        const savedSession = client.session.save();
        if (typeof savedSession !== 'string' || !savedSession) throw new TelegramAuthError('SESSION_ENCRYPTION_FAILED', 'session_encrypt', new Error('MTProto session is unavailable'));
        let encrypted: EncryptedTelegramSession;
        try { encrypted = this.cipher!.encrypt(savedSession); } catch (error) { throw new TelegramAuthError('SESSION_ENCRYPTION_FAILED', 'session_encrypt', error); }
        const id = createId('tgconn'); const shortId = token(); const now = new Date().toISOString(); const sessionStorageKey = `${shortId}.json`; const sessionPath = path.join(this.sessionsDirectory, sessionStorageKey);
        try { await fs.mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 }); await atomicWriteJson(sessionPath, encrypted); await fs.chmod(sessionPath, 0o600); } catch (error) { throw new TelegramAuthError('SESSION_PERSIST_FAILED', 'session_persist', error); }
        try { return await this.connections.save({ id, shortId, clubId, telegramUserId, displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(telegramUserId), username: user.username || undefined, sessionStorageKey, connectedAt: now, lastValidatedAt: now, status: 'connected' }); }
        catch (error) { await fs.rm(sessionPath, { force: true }).catch(() => undefined); throw new TelegramAuthError('SESSION_PERSIST_FAILED', 'metadata_persist', error); }
    }

    async beginAuthentication(clubId: string, requestingAdminTelegramUserId: number, phoneNumber: string): Promise<TelegramAuthenticationStage> {
        this.requireConfigured(); this.expireFlows();
        const phone = normalizeTelegramPhone(phoneNumber);
        const client = this.clientFactory(new StringSession(''));
        const flow: AuthFlow = { clubId, requestedBy: requestingAdminTelegramUserId, client, code: deferred(), password: deferred(), stage: 'starting', stageWaiters: [], expiresAt: this.now() + this.authTtlMs };
        this.authFlows.set(requestingAdminTelegramUserId, flow);
        this.logStage(flow, 'auth_started');
        this.logStage(flow, 'phone_submitted', { maskedPhone: maskPhone(phone) });
        void client.start({ phoneNumber: phone, phoneCode: async () => { this.logStage(flow, 'code_requested'); if (flow.stage !== 'code') this.setStage(flow, 'code'); return flow.code.promise; }, password: async () => { this.logStage(flow, 'password_required'); if (flow.stage !== 'password') this.setStage(flow, 'password'); return flow.password.promise; }, onError: async (error) => this.handleStartError(flow, error) })
            .then(() => { this.logStage(flow, 'auth_completed'); this.setStage(flow, 'completed'); }).catch((error) => this.failFlow(flow, error));
        return this.waitForStage(flow, 'starting');
    }

    async submitCode(requestingAdminTelegramUserId: number, code: string): Promise<TelegramAuthenticationStage> { const flow = this.flow(requestingAdminTelegramUserId); const normalized = normalizeTelegramCode(code); this.logStage(flow, 'code_submitted'); flow.code.resolve(normalized); return this.waitForStage(flow, 'code'); }
    async submitPassword(requestingAdminTelegramUserId: number, password: string): Promise<TelegramAuthenticationStage> { const flow = this.flow(requestingAdminTelegramUserId); this.logStage(flow, 'password_submitted'); flow.password.resolve(password); return this.waitForStage(flow, 'password'); }
    getAuthenticationFailure(requestingAdminTelegramUserId: number): TelegramAuthError { const flow = this.flow(requestingAdminTelegramUserId); return flow.error ?? new TelegramAuthError('UNKNOWN_AUTH_ERROR', flow.stage, new Error('Authentication failed without an underlying Telegram error')); }

    async completeAuthentication(requestingAdminTelegramUserId: number): Promise<TelegramUserConnection> {
        const flow = this.flow(requestingAdminTelegramUserId);
        if (flow.stage !== 'completed') throw flow.error ?? new Error('Telegram authentication is incomplete');
        let user: Awaited<ReturnType<TelegramClient['getMe']>>;
        try { user = await flow.client.getMe(); }
        catch (error) { throw classifyTelegramAuthError(error, 'session_validate'); }
        if (!(user instanceof Api.User)) throw new Error('Authenticated Telegram identity is unavailable');
        const telegramUserId = Number(user.id.toString());
        if (telegramUserId !== requestingAdminTelegramUserId) { await flow.client.disconnect(); this.authFlows.delete(requestingAdminTelegramUserId); throw new Error('AUTHENTICATED_ACCOUNT_MISMATCH'); }
        const id = createId('tgconn'); const shortId = token(); const now = new Date().toISOString(); const sessionStorageKey = `${shortId}.json`;
        const session = flow.client.session.save();
        if (typeof session !== 'string' || !session) throw new Error('TELEGRAM_SESSION_UNAVAILABLE');
        const sessionPath = path.join(this.sessionsDirectory, sessionStorageKey);
        let encrypted: EncryptedTelegramSession;
        try { encrypted = this.cipher!.encrypt(session); }
        catch (error) { throw new TelegramAuthError('SESSION_ENCRYPTION_FAILED', 'session_encrypt', error); }
        try { await fs.mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 }); await atomicWriteJson(sessionPath, encrypted); await fs.chmod(sessionPath, 0o600); }
        catch (error) { throw new TelegramAuthError('SESSION_PERSIST_FAILED', 'session_persist', error); }
        let connection: TelegramUserConnection;
        try { connection = await this.connections.save({ id, shortId, clubId: flow.clubId, telegramUserId, displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(telegramUserId), sessionStorageKey, connectedAt: now, lastValidatedAt: now, status: 'connected' }); }
        catch (error) { await fs.rm(sessionPath, { force: true }).catch(() => undefined); throw new TelegramAuthError('SESSION_PERSIST_FAILED', 'metadata_persist', error); }
        await flow.client.disconnect(); this.authFlows.delete(requestingAdminTelegramUserId);
        logger.info('telegram_user.connection_completed', { clubId: connection.clubId, connectionId: connection.id, telegramUserId });
        return connection;
    }

    async validate(connectionId: string): Promise<TelegramUserConnection> {
        const connection = await this.requiredConnection(connectionId);
        try { await this.withClient(connection, async (client) => client.getMe()); const updated = { ...connection, status: 'connected' as const, lastValidatedAt: new Date().toISOString() }; await this.connections.save(updated); logger.info('telegram_user.connection_validated', { clubId: connection.clubId, connectionId }); return updated; }
        catch (error) { const updated = { ...connection, status: 'reauth_required' as const }; await this.connections.save(updated); logger.warn('telegram_user.connection_expired', { clubId: connection.clubId, connectionId, reason: error instanceof Error ? error.message : String(error) }); return updated; }
    }

    async disconnect(connectionId: string, clubId: string): Promise<void> {
        const connection = await this.requiredConnection(connectionId); if (connection.clubId !== clubId) throw new Error('CLUB_CONTEXT_MISMATCH');
        await fs.rm(path.join(this.sessionsDirectory, connection.sessionStorageKey), { force: true });
        for (const source of (await this.sources.listByClub(clubId)).filter((item) => item.connectionId === connection.id)) await this.sources.delete(source.id);
        await this.connections.delete(connection.id); logger.info('telegram_user.disconnected', { clubId, connectionId, telegramUserId: connection.telegramUserId });
    }

    async listDialogs(connection: TelegramUserConnection, requestingUserId: number): Promise<TelegramGroupDialog[]> {
        if (connection.telegramUserId !== requestingUserId) throw new Error('CONNECTION_PRIVACY_DENIED');
        return this.withClient(connection, (client) => new TelegramParticipantLoader(client).listGroups());
    }
    async resolveAccessibleGroup(connection: TelegramUserConnection, requestingUserId: number, selector: { chatId?: string; username?: string }): Promise<TelegramGroupDialog> {
        if (connection.telegramUserId !== requestingUserId) throw new Error('CONNECTION_PRIVACY_DENIED');
        const normalizedUsername = selector.username?.replace(/^@/, '').toLocaleLowerCase();
        const group = await this.withClient(connection, async (client) => {
            const groups = await new TelegramParticipantLoader(client).listGroups();
            return findAccessibleTelegramGroup(groups, selector.chatId, normalizedUsername);
        });
        if (!group) throw new Error('TELEGRAM_SELECTED_GROUP_INACCESSIBLE');
        return group;
    }
    async addSource(clubId: string, connection: TelegramUserConnection, dialog: TelegramGroupDialog, addedBy: number): Promise<TelegramImportSource> {
        if (connection.clubId !== clubId || connection.telegramUserId !== addedBy) throw new Error('CONNECTION_PRIVACY_DENIED');
        const existing = (await this.sources.listByClub(clubId)).find((item) => item.telegramChatId === dialog.id && item.connectionId === connection.id); if (existing) return existing;
        return this.sources.save({ id: createId('tgsource'), shortId: token(), clubId, connectionId: connection.id, telegramChatId: dialog.id, title: dialog.title, addedBy, createdAt: new Date().toISOString() });
    }
    async scan(source: TelegramImportSource, clubId: string): Promise<{ participants: TelegramParticipant[]; contacts: TelegramContact[]; partial: boolean }> {
        if (source.clubId !== clubId) throw new Error('CLUB_CONTEXT_MISMATCH'); const connection = await this.requiredConnection(source.connectionId); if (connection.clubId !== clubId) throw new Error('CLUB_CONTEXT_MISMATCH');
        return this.withClient(connection, async (client) => { const loader = new TelegramParticipantLoader(client); const dialog = (await loader.listGroups()).find((item) => item.id === source.telegramChatId); if (!dialog) throw new Error('TELEGRAM_IMPORT_SOURCE_UNAVAILABLE'); const [loaded, contacts] = await Promise.all([loader.load(dialog), new TelegramContactsLoader(client).load()]); return { participants: loaded.participants, contacts, partial: loaded.partial }; });
    }

    async readRecentMessages(clubId: string, chatId: number, since: Date, limit = 200): Promise<TelegramHistoryMessage[]> {
        const source = (await this.sources.listByClub(clubId)).find((item) => item.telegramChatId === String(chatId));
        if (!source) throw new Error('TELEGRAM_RECOVERY_SOURCE_UNAVAILABLE');
        const connection = await this.requiredConnection(source.connectionId);
        if (connection.clubId !== clubId || connection.status !== 'connected') throw new Error('TELEGRAM_RECOVERY_SOURCE_UNAVAILABLE');
        return this.withClient(connection, async (client) => {
            const dialog = (await new TelegramParticipantLoader(client).listGroups()).find((item) => item.id === source.telegramChatId);
            if (!dialog) throw new Error('TELEGRAM_IMPORT_SOURCE_UNAVAILABLE');
            const values = await client.getMessages(dialog.entity, { limit });
            const result: TelegramHistoryMessage[] = [];
            for (const message of values) {
                const rawDate: unknown = message?.date;
                const date = rawDate instanceof Date ? rawDate : new Date(Number(rawDate) * 1000);
                if (!message?.message || message.out || Number.isNaN(date.getTime()) || date < since) continue;
                const sender = await message.getSender();
                if (!(sender instanceof Api.User) || sender.bot || sender.deleted || sender.self) continue;
                const id = Number(sender.id.toString());
                if (!Number.isSafeInteger(id) || id <= 0) continue;
                result.push({ messageId: Number(message.id), date, text: message.message, telegramUser: { id, first_name: sender.firstName, username: sender.username } });
            }
            return result;
        });
    }

    private async withClient<T>(connection: TelegramUserConnection, action: (client: TelegramClient) => Promise<T>): Promise<T> { const encrypted = await readReliableJson(path.join(this.sessionsDirectory, connection.sessionStorageKey), isEncrypted); const client = new TelegramClient(new StringSession(this.cipher!.decrypt(encrypted.data)), this.apiId, this.apiHash, { connectionRetries: 3 }); try { await client.connect(); if (!await client.checkAuthorization()) throw new Error('AUTH_KEY_UNREGISTERED'); return await action(client); } finally { await client.disconnect().catch(() => undefined); } }
    private async requiredConnection(id: string): Promise<TelegramUserConnection> { const value = await this.connections.findById(id); if (!value) throw new Error('TELEGRAM_CONNECTION_NOT_FOUND'); return value; }
    private requireConfigured(): void { if (!this.configured) throw new TelegramAuthError('TELEGRAM_API_CREDENTIALS_INVALID', 'config', new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION_ENCRYPTION_KEY is missing or invalid')); }
    private flow(id: number): AuthFlow { this.expireFlows(); const value = this.authFlows.get(id); if (!value) throw new TelegramAuthError('AUTH_FLOW_EXPIRED', 'expired', new Error('Temporary Telegram authentication flow expired')); return value; }
    private setStage(flow: AuthFlow, stage: TelegramAuthenticationStage): void { flow.stage = stage; for (const waiter of flow.stageWaiters.splice(0)) waiter(stage); }
    private waitForStage(flow: AuthFlow, previous?: TelegramAuthenticationStage): Promise<TelegramAuthenticationStage> { if (!previous || flow.stage !== previous) return Promise.resolve(flow.stage); return new Promise((resolve) => flow.stageWaiters.push(resolve)); }
    private expireFlows(): void { for (const [id, flow] of this.authFlows) if (flow.expiresAt <= this.now()) { this.logFailure(new TelegramAuthError('AUTH_FLOW_EXPIRED', flow.stage, new Error('Temporary authentication flow expired')), flow); void flow.client.disconnect(); this.authFlows.delete(id); } }
    private async handleStartError(flow: AuthFlow, error: Error): Promise<boolean> {
        const failure = classifyTelegramAuthError(error, flow.stage === 'password' ? 'password_submitted' : flow.stage === 'code' ? 'code_submitted' : 'phone_submitted');
        flow.error = failure; this.logFailure(failure, flow);
        if (failure.reason === 'SESSION_PASSWORD_NEEDED') { flow.password = deferred(); this.setStage(flow, 'password'); return false; }
        if (isRetryableTelegramAuthFailure(failure.reason)) {
            if (failure.reason === 'PHONE_CODE_INVALID') { flow.code = deferred(); this.setStage(flow, 'code'); }
            else { flow.password = deferred(); this.setStage(flow, 'password'); }
            return false;
        }
        return true;
    }
    private failFlow(flow: AuthFlow, error: unknown): void { const failure = flow.error ?? classifyTelegramAuthError(error, flow.stage); if (!flow.error) this.logFailure(failure, flow); flow.error = failure; this.setStage(flow, 'failed'); }
    private logStage(flow: AuthFlow, stage: string, fields: Record<string, unknown> = {}): void { logger.info('telegram_user.auth_stage', { clubId: flow.clubId, telegramUserId: flow.requestedBy, stage, ...fields }); }
    private logFailure(failure: TelegramAuthError, flow: AuthFlow): void { const original = safeTelegramErrorDetails(failure.original); logger.error('telegram_user.connection_failed', { clubId: flow.clubId, telegramUserId: flow.requestedBy, stage: failure.stage, reason: failure.reason, errorName: original.name, errorMessage: original.message, errorCode: original.code, rpcErrorMessage: original.errorMessage, stack: original.stack }); }
}

function deferred(): Deferred { let resolve!: (value: string) => void; return { promise: new Promise((done) => { resolve = done; }), resolve }; }
function token(): string { return randomBytes(6).toString('base64url'); }
function isEncrypted(value: unknown): value is EncryptedTelegramSession { return Boolean(value && typeof value === 'object' && (value as EncryptedTelegramSession).version === 1 && typeof (value as EncryptedTelegramSession).ciphertext === 'string'); }
function maskPhone(phone: string): string { return `${phone.slice(0, Math.min(4, phone.length))}${'*'.repeat(Math.max(0, phone.length - 6))}${phone.slice(-2)}`; }

export function findAccessibleTelegramGroup(groups: readonly TelegramGroupDialog[], chatId?: string, normalizedUsername?: string): TelegramGroupDialog | undefined {
    return groups.find((item) => item.id === chatId
        || (typeof item.entity === 'object' && item.entity !== null && 'username' in item.entity
            && typeof item.entity.username === 'string' && item.entity.username.toLocaleLowerCase() === normalizedUsername));
}
