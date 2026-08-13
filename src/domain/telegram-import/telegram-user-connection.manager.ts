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

export type TelegramAuthenticationStage = 'starting' | 'code' | 'password' | 'completed' | 'failed';
type Deferred = { promise: Promise<string>; resolve(value: string): void };
type AuthFlow = { clubId: string; requestedBy: number; client: TelegramClient; code: Deferred; password: Deferred; stage: TelegramAuthenticationStage; stageWaiters: Array<(stage: TelegramAuthenticationStage) => void>; error?: Error; expiresAt: number };

export class TelegramUserConnectionManager {
    readonly configured: boolean;
    private readonly apiId: number;
    private readonly apiHash: string;
    private readonly cipher?: TelegramSessionCipher;
    private readonly sessionsDirectory: string;
    private readonly connections: TelegramUserConnectionRepository;
    private readonly sources: TelegramImportSourceRepository;
    private readonly authFlows = new Map<number, AuthFlow>();

    constructor(dataDir: string, config = { apiId: Number(process.env.TELEGRAM_API_ID), apiHash: process.env.TELEGRAM_API_HASH ?? '', encryptionKey: process.env.TELEGRAM_SESSION_ENCRYPTION_KEY ?? '' }) {
        const system = path.join(dataDir, '_system');
        this.apiId = config.apiId; this.apiHash = config.apiHash.trim();
        this.configured = Number.isSafeInteger(this.apiId) && this.apiId > 0 && Boolean(this.apiHash && config.encryptionKey);
        this.cipher = this.configured ? new TelegramSessionCipher(config.encryptionKey) : undefined;
        this.sessionsDirectory = path.join(system, 'telegram-sessions');
        this.connections = new TelegramUserConnectionRepository(path.join(system, 'telegram-user-connections.json'));
        this.sources = new TelegramImportSourceRepository(path.join(system, 'telegram-import-sources.json'));
    }

    async getConnections(clubId: string): Promise<TelegramUserConnection[]> { return this.connections.listByClub(clubId); }
    async getConnection(clubId: string): Promise<TelegramUserConnection | undefined> { const values = await this.getConnections(clubId); return [...values].reverse().find((item) => item.status === 'connected') ?? values.at(-1); }
    async getSources(clubId: string): Promise<TelegramImportSource[]> { return this.sources.listByClub(clubId); }
    async getSourceByShortId(clubId: string, shortId: string): Promise<TelegramImportSource | undefined> { const source = await this.sources.findByShortId(shortId); return source?.clubId === clubId ? source : undefined; }
    async cancelAuthentication(requestingAdminTelegramUserId: number): Promise<void> { const flow = this.authFlows.get(requestingAdminTelegramUserId); if (!flow) return; this.authFlows.delete(requestingAdminTelegramUserId); await flow.client.disconnect().catch(() => undefined); }

    async beginAuthentication(clubId: string, requestingAdminTelegramUserId: number, phoneNumber: string): Promise<TelegramAuthenticationStage> {
        this.requireConfigured(); this.expireFlows();
        const client = new TelegramClient(new StringSession(''), this.apiId, this.apiHash, { connectionRetries: 5 });
        const flow: AuthFlow = { clubId, requestedBy: requestingAdminTelegramUserId, client, code: deferred(), password: deferred(), stage: 'starting', stageWaiters: [], expiresAt: Date.now() + 10 * 60_000 };
        this.authFlows.set(requestingAdminTelegramUserId, flow);
        logger.info('telegram_user.connection_started', { clubId, requestingAdminTelegramUserId });
        void client.start({ phoneNumber, phoneCode: async () => { this.setStage(flow, 'code'); return flow.code.promise; }, password: async () => { this.setStage(flow, 'password'); return flow.password.promise; }, onError: async (error) => { flow.error = error; return true; } })
            .then(() => this.setStage(flow, 'completed')).catch((error) => { flow.error = error instanceof Error ? error : new Error(String(error)); this.setStage(flow, 'failed'); });
        return this.waitForStage(flow, 'starting');
    }

    async submitCode(requestingAdminTelegramUserId: number, code: string): Promise<TelegramAuthenticationStage> { const flow = this.flow(requestingAdminTelegramUserId); flow.code.resolve(code); return this.waitForStage(flow, 'code'); }
    async submitPassword(requestingAdminTelegramUserId: number, password: string): Promise<TelegramAuthenticationStage> { const flow = this.flow(requestingAdminTelegramUserId); flow.password.resolve(password); return this.waitForStage(flow, 'password'); }

    async completeAuthentication(requestingAdminTelegramUserId: number): Promise<TelegramUserConnection> {
        const flow = this.flow(requestingAdminTelegramUserId);
        if (flow.stage !== 'completed') throw flow.error ?? new Error('Telegram authentication is incomplete');
        const user = await flow.client.getMe();
        if (!(user instanceof Api.User)) throw new Error('Authenticated Telegram identity is unavailable');
        const telegramUserId = Number(user.id.toString());
        if (telegramUserId !== requestingAdminTelegramUserId) { await flow.client.disconnect(); this.authFlows.delete(requestingAdminTelegramUserId); throw new Error('AUTHENTICATED_ACCOUNT_MISMATCH'); }
        const id = createId('tgconn'); const shortId = token(); const now = new Date().toISOString(); const sessionStorageKey = `${shortId}.json`;
        await fs.mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 });
        const session = flow.client.session.save();
        if (typeof session !== 'string' || !session) throw new Error('TELEGRAM_SESSION_UNAVAILABLE');
        const sessionPath = path.join(this.sessionsDirectory, sessionStorageKey);
        await atomicWriteJson(sessionPath, this.cipher!.encrypt(session));
        await fs.chmod(sessionPath, 0o600);
        const connection = await this.connections.save({ id, shortId, clubId: flow.clubId, telegramUserId, displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(telegramUserId), sessionStorageKey, connectedAt: now, lastValidatedAt: now, status: 'connected' });
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
    async addSource(clubId: string, connection: TelegramUserConnection, dialog: TelegramGroupDialog, addedBy: number): Promise<TelegramImportSource> {
        if (connection.clubId !== clubId || connection.telegramUserId !== addedBy) throw new Error('CONNECTION_PRIVACY_DENIED');
        const existing = (await this.sources.listByClub(clubId)).find((item) => item.telegramChatId === dialog.id && item.connectionId === connection.id); if (existing) return existing;
        return this.sources.save({ id: createId('tgsource'), shortId: token(), clubId, connectionId: connection.id, telegramChatId: dialog.id, title: dialog.title, addedBy, createdAt: new Date().toISOString() });
    }
    async scan(source: TelegramImportSource, clubId: string): Promise<{ participants: TelegramParticipant[]; contacts: TelegramContact[]; partial: boolean }> {
        if (source.clubId !== clubId) throw new Error('CLUB_CONTEXT_MISMATCH'); const connection = await this.requiredConnection(source.connectionId); if (connection.clubId !== clubId) throw new Error('CLUB_CONTEXT_MISMATCH');
        return this.withClient(connection, async (client) => { const loader = new TelegramParticipantLoader(client); const dialog = (await loader.listGroups()).find((item) => item.id === source.telegramChatId); if (!dialog) throw new Error('TELEGRAM_IMPORT_SOURCE_UNAVAILABLE'); const [loaded, contacts] = await Promise.all([loader.load(dialog), new TelegramContactsLoader(client).load()]); return { participants: loaded.participants, contacts, partial: loaded.partial }; });
    }

    private async withClient<T>(connection: TelegramUserConnection, action: (client: TelegramClient) => Promise<T>): Promise<T> { const encrypted = await readReliableJson(path.join(this.sessionsDirectory, connection.sessionStorageKey), isEncrypted); const client = new TelegramClient(new StringSession(this.cipher!.decrypt(encrypted.data)), this.apiId, this.apiHash, { connectionRetries: 3 }); try { await client.connect(); if (!await client.checkAuthorization()) throw new Error('AUTH_KEY_UNREGISTERED'); return await action(client); } finally { await client.disconnect().catch(() => undefined); } }
    private async requiredConnection(id: string): Promise<TelegramUserConnection> { const value = await this.connections.findById(id); if (!value) throw new Error('TELEGRAM_CONNECTION_NOT_FOUND'); return value; }
    private requireConfigured(): void { if (!this.configured) throw new Error('TELEGRAM_USER_CONNECTION_NOT_CONFIGURED'); }
    private flow(id: number): AuthFlow { this.expireFlows(); const value = this.authFlows.get(id); if (!value) throw new Error('TELEGRAM_AUTH_FLOW_EXPIRED'); return value; }
    private setStage(flow: AuthFlow, stage: TelegramAuthenticationStage): void { flow.stage = stage; for (const waiter of flow.stageWaiters.splice(0)) waiter(stage); }
    private waitForStage(flow: AuthFlow, previous?: TelegramAuthenticationStage): Promise<TelegramAuthenticationStage> { if (!previous || flow.stage !== previous) return Promise.resolve(flow.stage); return new Promise((resolve) => flow.stageWaiters.push(resolve)); }
    private expireFlows(): void { for (const [id, flow] of this.authFlows) if (flow.expiresAt <= Date.now()) { void flow.client.disconnect(); this.authFlows.delete(id); } }
}

function deferred(): Deferred { let resolve!: (value: string) => void; return { promise: new Promise((done) => { resolve = done; }), resolve }; }
function token(): string { return randomBytes(6).toString('base64url'); }
function isEncrypted(value: unknown): value is EncryptedTelegramSession { return Boolean(value && typeof value === 'object' && (value as EncryptedTelegramSession).version === 1 && typeof (value as EncryptedTelegramSession).ciphertext === 'string'); }
