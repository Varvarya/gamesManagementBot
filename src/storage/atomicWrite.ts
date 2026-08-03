import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger';

export const CURRENT_SCHEMA_VERSION = 2;
export type StorageDocument<T> = { schemaVersion: number; data: T };
const pendingWrites = new Set<Promise<void>>();

export function atomicWriteJson<T>(filePath: string, data: T): Promise<void> {
    const operation = writeAtomic(filePath, data);
    pendingWrites.add(operation);
    void operation.finally(() => pendingWrites.delete(operation)).catch(() => undefined);
    return operation;
}

export async function waitForPendingWrites(): Promise<void> {
    await Promise.allSettled([...pendingWrites]);
}

async function writeAtomic<T>(filePath: string, data: T): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const document: StorageDocument<T> = { schemaVersion: CURRENT_SCHEMA_VERSION, data };
    const handle = await fs.open(tmpPath, 'w');
    try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        throw error;
    }
    await handle.close();
    await fs.rename(tmpPath, filePath);
    try {
        const directory = await fs.open(dir, 'r');
        await directory.sync();
        await directory.close();
    } catch { /* Directory fsync is unavailable on some platforms. */ }
}

export async function readReliableJson<T>(filePath: string, validate: (value: unknown) => value is T): Promise<{ data: T; schemaVersion: number; migrated: boolean }> {
    try {
        return await readCandidate(filePath, validate);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw error;
        logger.error('storage.repository_invalid', { repository: path.basename(filePath), error });
        const recovered = await recoverFromBackup(filePath, validate);
        if (recovered) {
            logger.warn('storage.repository_recovered', { repository: path.basename(filePath), backup: recovered.source });
            return recovered.value;
        }
        throw new Error(`Repository ${path.basename(filePath)} is invalid and no valid backup exists`, { cause: error });
    }
}

async function readCandidate<T>(filePath: string, validate: (value: unknown) => value is T): Promise<{ data: T; schemaVersion: number; migrated: boolean }> {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const isDocument = isStorageDocument(parsed);
    const data = isDocument ? parsed.data : parsed;
    if (!validate(data)) throw new Error('Repository schema validation failed');
    const version = isDocument ? parsed.schemaVersion : 0;
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Unsupported schema version ${version}`);
    return { data, schemaVersion: version, migrated: version < CURRENT_SCHEMA_VERSION };
}

async function recoverFromBackup<T>(filePath: string, validate: (value: unknown) => value is T) {
    const backupRoot = path.join(path.dirname(filePath), 'backups');
    let directories: string[];
    try { directories = (await fs.readdir(backupRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort().reverse(); }
    catch { return undefined; }
    for (const directory of directories) {
        const candidate = path.join(backupRoot, directory, path.basename(filePath));
        try { return { source: directory, value: await readCandidate(candidate, validate) }; }
        catch { continue; }
    }
    return undefined;
}

export async function backupBeforeMigration(filePath: string, oldVersion: number): Promise<void> {
    const backupRoot = path.join(path.dirname(filePath), 'backups');
    const directory = path.join(backupRoot, `migration-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(filePath, path.join(directory, path.basename(filePath)));
    logger.info('storage.migration_backup_created', { repository: path.basename(filePath), oldSchemaVersion: oldVersion, newSchemaVersion: CURRENT_SCHEMA_VERSION });
}

function isStorageDocument(value: unknown): value is StorageDocument<unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'schemaVersion' in value && Number.isInteger((value as StorageDocument<unknown>).schemaVersion) && 'data' in value);
}
