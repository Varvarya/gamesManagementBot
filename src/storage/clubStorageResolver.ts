import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubSettings } from '../domain/settings/settings.types';
import { logger } from '../utils/logger';

export type ResolvedClubStorage = {
    clubId: string;
    title: string;
    storageSlug: string;
    directoryPath: string;
};

type ResolveOptions = { dataDir: string; clubId?: string };

/**
 * Legacy CLI lookup only. Application startup uses the system ClubRepository.
 * This function never creates or bootstraps a club from environment values.
 */
export async function resolveClubStorage(options: ResolveOptions): Promise<ResolvedClubStorage | undefined> {
    const dataDir = path.resolve(options.dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    const candidates: Array<{ settings: ClubSettings; directoryName: string }> = [];
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_system' || entry.name === 'default') continue;
        const settings = await readSettings(path.join(dataDir, entry.name, 'settings.json'));
        if (settings) candidates.push({ settings, directoryName: entry.name });
    }
    const existing = candidates.find((candidate) => Boolean(options.clubId && candidate.settings.clubId === options.clubId))
        ?? (!options.clubId && candidates.length === 1 ? candidates[0] : undefined);
    if (!existing) return undefined;
    const storageSlug = existing.settings.storageSlug || existing.directoryName;
    const resolved = { clubId: existing.settings.clubId, title: existing.settings.title, storageSlug, directoryPath: path.join(dataDir, storageSlug) };
    logger.info('club.storage_resolved', { ...resolved, path: resolved.directoryPath });
    return resolved;
}

async function readSettings(file: string): Promise<ClubSettings | undefined> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        const value = parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: unknown }).data : parsed;
        return value && typeof value === 'object' && typeof (value as ClubSettings).clubId === 'string' ? value as ClubSettings : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}
