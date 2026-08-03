import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubSettings } from '../domain/settings/settings.types';
import { logger } from '../utils/logger';
import { createClubSlug } from './clubSlug';
import { atomicWriteJson } from './atomicWrite';

export type ResolvedClubStorage = {
    clubId: string;
    title: string;
    storageSlug: string;
    directoryPath: string;
};

type ResolveOptions = { dataDir: string; clubId?: string; clubName?: string };

export async function resolveClubStorage(options: ResolveOptions): Promise<ResolvedClubStorage> {
    const dataDir = path.resolve(options.dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    const legacyDirectory = path.join(dataDir, 'default');
    const legacy = await readSettings(path.join(legacyDirectory, 'settings.json'));
    const configuredName = options.clubName?.trim();
    const legacyRealTitle = legacy?.title?.trim() && legacy.title.trim().toLocaleLowerCase('en') !== 'default'
        ? legacy.title.trim()
        : undefined;
    const existing = await findExistingClub(dataDir, options.clubId, configuredName);
    const title = existing?.settings.title?.trim() || configuredName || legacyRealTitle;
    if (!title) throw new Error('CLUB_NAME is required for the first launch because no saved club settings were found');
    const storedSlug = existing?.settings.storageSlug || (legacyRealTitle ? legacy?.storageSlug : undefined);
    const storageSlug = storedSlug || existing?.directoryName || createClubSlug(title);
    const directoryPath = path.join(dataDir, storageSlug);
    const clubId = existing?.settings.clubId?.trim() || legacy?.clubId?.trim() || options.clubId?.trim() || storageSlug;

    if (legacyRealTitle && path.resolve(legacyDirectory) !== path.resolve(directoryPath)) {
        await migrateDefaultDirectory(legacyDirectory, directoryPath, { clubId, title, storageSlug });
    }
    await fs.mkdir(directoryPath, { recursive: true });
    logger.info('club.storage_resolved', { clubId, title, storageSlug, path: directoryPath });
    return { clubId, title, storageSlug, directoryPath };
}

async function findExistingClub(dataDir: string, clubId?: string, clubName?: string): Promise<{ settings: ClubSettings; directoryName: string } | undefined> {
    const candidates: Array<{ settings: ClubSettings; directoryName: string }> = [];
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'default' || entry.name.startsWith('.')) continue;
        const settings = await readSettings(path.join(dataDir, entry.name, 'settings.json'));
        if (settings) candidates.push({ settings, directoryName: entry.name });
    }
    return candidates.find((candidate) => Boolean(clubId && candidate.settings.clubId === clubId))
        ?? candidates.find((candidate) => Boolean(clubName && (candidate.settings.storageSlug === createClubSlug(clubName) || candidate.directoryName === createClubSlug(clubName))))
        ?? (candidates.length === 1 ? candidates[0] : undefined);
}

async function migrateDefaultDirectory(source: string, destination: string, identity: Pick<ClubSettings, 'clubId' | 'title' | 'storageSlug'>): Promise<void> {
    if (!await isDirectory(source)) return;
    logger.info('club.storage_migration_started', { ...identity, path: destination });
    if (await isNonEmptyDirectory(destination)) {
        logger.warn('club.storage_migration_completed', { ...identity, path: destination, result: 'skipped_destination_not_empty' });
        return;
    }
    const backup = path.join(path.dirname(source), '.migration-backups', `default-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.cp(source, backup, { recursive: true, errorOnExist: true, force: false });
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await verifyDirectory(source, destination);
    const settingsPath = path.join(destination, 'settings.json');
    const settings = await readSettings(settingsPath);
    if (settings) await atomicWriteJson(settingsPath, { ...settings, ...identity, updatedAt: new Date().toISOString() });
    logger.info('club.storage_migration_completed', { ...identity, path: destination, result: 'copied_and_verified', backup });
}

async function verifyDirectory(source: string, destination: string): Promise<void> {
    const sourceFiles = await listFiles(source);
    const destinationFiles = await listFiles(destination);
    if (sourceFiles.join('\n') !== destinationFiles.join('\n')) throw new Error('Club storage migration verification failed: file lists differ');
    for (const file of sourceFiles) {
        const [left, right] = await Promise.all([fs.readFile(path.join(source, file)), fs.readFile(path.join(destination, file))]);
        if (createHash('sha256').update(left).digest('hex') !== createHash('sha256').update(right).digest('hex')) throw new Error(`Club storage migration verification failed: ${file}`);
    }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) result.push(...await listFiles(root, relative));
        else if (entry.isFile()) result.push(relative);
    }
    return result.sort();
}

async function readSettings(file: string): Promise<ClubSettings | undefined> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        const value = parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: unknown }).data : parsed;
        return value as ClubSettings;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function isDirectory(directory: string): Promise<boolean> {
    try { return (await fs.stat(directory)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function isNonEmptyDirectory(directory: string): Promise<boolean> {
    return await isDirectory(directory) && (await fs.readdir(directory)).length > 0;
}
