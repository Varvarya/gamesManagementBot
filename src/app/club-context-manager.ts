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
    storageSlug: string;
    directoryPath: string;
    repositories: RepositoriesContext;
    services: ServicesContext;
};

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
        return this.loadClubContext(clubId);
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
        if (!club) throw new Error(`Club ${clubId} is absent from the registry`);
        const storageSlug = club.slug;
        const directoryPath = path.resolve(this.dataDir, storageSlug);
        const dataRoot = path.resolve(this.dataDir);
        if (path.dirname(directoryPath) !== dataRoot || path.basename(directoryPath) !== storageSlug) {
            throw new Error(`Unsafe storageSlug for club ${clubId}`);
        }
        logger.info('club.context_load_started', { clubId, storageSlug, path: directoryPath });
        try {
            const stat = await fs.stat(directoryPath);
            if (!stat.isDirectory()) throw new Error('Club storage path is not a directory');
            const storage = new JsonStorage({ dataDir: this.dataDir, storageSlug });
            const repositories = new RepositoriesContext(storage, this.defaultTimezone, { clubId, title: club.name, storageSlug });
            await repositories.loadAll();
            const settings = await repositories.settings.get();
            if (settings.clubId !== clubId) throw new Error(`Registry clubId ${clubId} does not match settings.clubId ${settings.clubId}`);
            if (settings.storageSlug !== storageSlug) throw new Error(`Registry storageSlug ${storageSlug} does not match settings.storageSlug ${settings.storageSlug}`);
            if (repositories.clubId !== clubId) throw new Error(`Repository context ${repositories.clubId} does not match registry ${clubId}`);
            const services = new ServicesContext(repositories, this.sessions);
            const [chats, templates, players, trainings] = await Promise.all([
                repositories.chats.getAll(), repositories.templates.list(), repositories.players.list(), repositories.trainings.list(),
            ]);
            logger.info('club.context_load_completed', { clubId, storageSlug, path: directoryPath, chatCount: chats.length, templateCount: templates.length, playerCount: players.length, trainingCount: trainings.length });
            return { clubId, storageSlug, directoryPath, repositories, services };
        } catch (error) {
            logger.error('club.context_load_failed', { clubId, storageSlug, path: directoryPath, reason: error instanceof Error ? error.message : String(error) });
            throw error;
        }
    }
}
