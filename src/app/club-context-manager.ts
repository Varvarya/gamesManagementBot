import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubRepository } from '../storage/repositories/club.repository';
import { JsonStorage } from '../storage/jsonStorage';
import { logger } from '../utils/logger';
import { RepositoriesContext } from './repositories.context';
import { ServicesContext } from './services.context';
import { SessionContextService } from '../bot/session/session-context.service';

export type ClubRuntimeContext = {
    clubId: string;
    title: string;
    storageSlug: string;
    directoryPath: string;
    repositories: RepositoriesContext;
    services: ServicesContext;
};

export type ClubContextLoadFailure = 'CLUB_NOT_IN_REGISTRY' | 'STORAGE_NOT_FOUND' | 'SETTINGS_NOT_FOUND' | 'SETTINGS_INVALID' | 'CLUB_ID_MISMATCH' | 'STORAGE_SLUG_MISMATCH' | 'REPOSITORY_LOAD_FAILED';
export class ClubContextLoadError extends Error {
    constructor(readonly code: ClubContextLoadFailure, message: string, readonly details: Record<string, unknown> = {}, options?: ErrorOptions) { super(message, options); this.name = 'ClubContextLoadError'; }
}

export class ClubContextManager {
    private readonly contexts = new Map<string, Promise<ClubRuntimeContext>>();

    constructor(
        private readonly dataDir: string,
        private readonly defaultTimezone: string,
        private readonly clubs: ClubRepository,
        private readonly sessions?: SessionContextService,
    ) {}

    hasClubContext(clubId: string): boolean { return this.contexts.has(clubId); }

    registerClubContext(context: ClubRuntimeContext): void {
        if (context.clubId !== context.repositories.clubId) throw new Error('Cannot register mismatched club context');
        this.contexts.set(context.clubId, Promise.resolve(context));
    }

    async getClubContext(clubId: string): Promise<ClubRuntimeContext> {
        const cached = this.contexts.get(clubId);
        if (!cached) return this.loadClubContext(clubId);
        try {
            const context = await cached;
            await this.validateCachedContext(clubId, context);
            return context;
        } catch (error) {
            logger.warn('club.context_cache_invalid', { clubId, reason: error instanceof Error ? error.message : String(error) });
            this.invalidateClubContext(clubId);
            return this.loadClubContext(clubId); // exactly one fresh retry
        }
    }

    async loadClubContext(clubId: string): Promise<ClubRuntimeContext> {
        const cached = this.contexts.get(clubId);
        if (cached) return cached;
        const loading = this.createContext(clubId);
        this.contexts.set(clubId, loading);
        try { return await loading; }
        catch (error) {
            if (this.contexts.get(clubId) === loading) this.contexts.delete(clubId);
            throw error;
        }
    }

    invalidateClubContext(clubId: string): void { this.contexts.delete(clubId); }

    async reloadClubContext(clubId: string): Promise<ClubRuntimeContext> {
        this.invalidateClubContext(clubId);
        return this.loadClubContext(clubId);
    }

    async listLoadedContexts(): Promise<ClubRuntimeContext[]> {
        return Promise.all([...this.contexts.values()]);
    }

    private async createContext(clubId: string): Promise<ClubRuntimeContext> {
        const club = await this.clubs.findById(clubId);
        if (!club) { logger.error('club.context_load_failed', { selectedClubId: clubId, registryClubFound: false, reason: 'CLUB_NOT_IN_REGISTRY' }); throw new ClubContextLoadError('CLUB_NOT_IN_REGISTRY', `Club ${clubId} is absent from the registry`, { selectedClubId: clubId }); }
        const storageSlug = club.slug;
        const directoryPath = path.resolve(this.dataDir, storageSlug);
        const settingsPath = path.join(directoryPath, 'settings.json');
        const dataRoot = path.resolve(this.dataDir);
        if (path.dirname(directoryPath) !== dataRoot || path.basename(directoryPath) !== storageSlug) {
            throw new ClubContextLoadError('STORAGE_NOT_FOUND', `Unsafe storageSlug for club ${clubId}`, { clubId, storageSlug, directoryPath });
        }
        const directoryExists = await isDirectory(directoryPath);
        const settingsFileExists = await isFile(settingsPath);
        logger.info('club.context_load_started', { selectedClubId: clubId, registryClubFound: true, registryClubTitle: club.name, registryStorageSlug: storageSlug, resolvedDirectoryPath: directoryPath, directoryExists, settingsFileExists });
        if (!directoryExists) {
            const candidates = await this.findStorageCandidates(storageSlug, clubId);
            throw this.fail('STORAGE_NOT_FOUND', `Club storage directory does not exist: ${directoryPath}`, { clubId, storageSlug, directoryPath, candidates });
        }
        if (!settingsFileExists) throw this.fail('SETTINGS_NOT_FOUND', `Club settings file does not exist: ${settingsPath}`, { clubId, storageSlug, directoryPath, settingsPath });
        try {
            let rawSettings: unknown;
            try { rawSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8')); }
            catch (error) { throw new ClubContextLoadError('SETTINGS_INVALID', `Club settings are invalid: ${settingsPath}`, { clubId, storageSlug, settingsPath }, { cause: error }); }
            const storedSettings = rawSettings && typeof rawSettings === 'object' && 'data' in rawSettings ? (rawSettings as { data: unknown }).data : rawSettings;
            if (!storedSettings || typeof storedSettings !== 'object' || typeof (storedSettings as { clubId?: unknown }).clubId !== 'string') throw new ClubContextLoadError('SETTINGS_INVALID', `Club settings have no valid clubId: ${settingsPath}`, { clubId, storageSlug, settingsPath });
            const storedClubId = (storedSettings as { clubId: string }).clubId;
            if (storedClubId !== clubId) { logger.error('club.context_id_mismatch', { registryClubId: clubId, settingsClubId: storedClubId, storageSlug }); throw new ClubContextLoadError('CLUB_ID_MISMATCH', `Registry clubId ${clubId} does not match settings.clubId ${storedClubId}`, { registryClubId: clubId, settingsClubId: storedClubId, storageSlug }); }
            const storedSlug = (storedSettings as { storageSlug?: unknown }).storageSlug;
            if (typeof storedSlug === 'string' && storedSlug !== storageSlug) throw new ClubContextLoadError('STORAGE_SLUG_MISMATCH', `Registry storageSlug ${storageSlug} does not match settings.storageSlug ${storedSlug}`, { clubId, registryStorageSlug: storageSlug, settingsStorageSlug: storedSlug });
            const storage = new JsonStorage({ dataDir: this.dataDir, storageSlug });
            const repositories = new RepositoriesContext(storage, this.defaultTimezone, { clubId, title: club.name, storageSlug });
            await repositories.loadAll();
            const settings = await repositories.settings.get();
            if (settings.clubId !== clubId) throw new ClubContextLoadError('CLUB_ID_MISMATCH', `Registry clubId ${clubId} does not match settings.clubId ${settings.clubId}`);
            if (settings.storageSlug !== storageSlug) throw new ClubContextLoadError('STORAGE_SLUG_MISMATCH', `Registry storageSlug ${storageSlug} does not match settings.storageSlug ${settings.storageSlug}`);
            if (repositories.clubId !== clubId) throw new Error(`Repository context ${repositories.clubId} does not match registry ${clubId}`);
            const services = new ServicesContext(repositories, this.sessions);
            const [chats, templates, players, trainings] = await Promise.all([
                repositories.chats.getAll(), repositories.templates.list(), repositories.players.list(), repositories.trainings.list(),
            ]);
            logger.info('club.context_load_completed', { clubId, storageSlug, path: directoryPath, directoryExists: true, settingsFileExists: true, settingsLoaded: true, settingsClubId: settings.clubId, repositoriesLoaded: true, contextCreated: true, chatCount: chats.length, templateCount: templates.length, playerCount: players.length, trainingCount: trainings.length });
            return { clubId, title: club.name, storageSlug, directoryPath, repositories, services };
        } catch (error) {
            const normalized = error instanceof ClubContextLoadError ? error : new ClubContextLoadError('REPOSITORY_LOAD_FAILED', `Failed to load repositories for club ${clubId}`, { clubId, storageSlug, directoryPath }, { cause: error });
            logger.error('club.context_load_failed', { clubId, storageSlug, path: directoryPath, code: normalized.code, reason: normalized.message });
            throw normalized;
        }
    }

    private async validateCachedContext(clubId: string, context: ClubRuntimeContext): Promise<void> {
        const club = await this.clubs.findById(clubId);
        if (!club) throw new ClubContextLoadError('CLUB_NOT_IN_REGISTRY', `Club ${clubId} is absent from the registry`);
        const expectedPath = path.resolve(this.dataDir, club.slug);
        const settings = await context.repositories.settings.get();
        if (context.clubId !== clubId || context.repositories.clubId !== clubId || settings.clubId !== clubId) throw new ClubContextLoadError('CLUB_ID_MISMATCH', 'Cached club context has mismatched clubId');
        if (context.storageSlug !== club.slug || context.directoryPath !== expectedPath || settings.storageSlug !== club.slug) throw new ClubContextLoadError('STORAGE_SLUG_MISMATCH', 'Cached club context has mismatched storage path');
        if (!await isDirectory(expectedPath) || !await isFile(path.join(expectedPath, 'settings.json'))) throw new ClubContextLoadError('STORAGE_NOT_FOUND', 'Cached club storage is no longer available');
    }
    private fail(code: ClubContextLoadFailure, message: string, details: Record<string, unknown>): ClubContextLoadError { logger.error('club.context_load_failed', { ...details, code, reason: message }); return new ClubContextLoadError(code, message, details); }
    private async findStorageCandidates(storageSlug: string, clubId: string): Promise<string[]> { try { const entries = (await fs.readdir(this.dataDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== '_system'); const matches: string[] = []; for (const entry of entries) { if (entry.name.toLocaleLowerCase() === storageSlug.toLocaleLowerCase()) { matches.push(entry.name); continue; } try { const raw: unknown = JSON.parse(await fs.readFile(path.join(this.dataDir, entry.name, 'settings.json'), 'utf8')); const settings = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw; if (settings && typeof settings === 'object' && (settings as { clubId?: unknown }).clubId === clubId) matches.push(entry.name); } catch { /* Candidate diagnostics must not hide the primary failure. */ } } return matches; } catch { return []; } }
}

async function isDirectory(value: string): Promise<boolean> { try { return (await fs.stat(value)).isDirectory(); } catch { return false; } }
async function isFile(value: string): Promise<boolean> { try { return (await fs.stat(value)).isFile(); } catch { return false; } }
