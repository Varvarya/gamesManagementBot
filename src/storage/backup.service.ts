import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonStorage } from './jsonStorage';
import { logger } from '../utils/logger';
import { waitForPendingWrites } from './atomicWrite';

type BackupManifest = {
    version: 1;
    createdAt: string;
    files: string[];
    checksums: Record<string, string>;
};

export type BackupResult = { directory: string; createdAt: string; files: string[] };
export type RestoreResult = { backupDirectory: string; restoredAt: string; files: string[]; safetyBackupDirectory: string };

export class BackupService {
    private operationQueue: Promise<void> = Promise.resolve();
    private lastCreatedAtMs = 0;

    constructor(
        private readonly storage: JsonStorage,
        private readonly retention = 5,
        private readonly configuredRoot?: string,
    ) {
        if (!Number.isSafeInteger(retention) || retention < 1) {
            throw new Error('Backup retention must be a positive integer');
        }
    }

    create(): Promise<BackupResult> {
        return this.serialize(() => this.createOnce());
    }

    restore(backup: string): Promise<RestoreResult> {
        return this.serialize(async () => {
            const source = await this.resolveBackup(backup);
            const snapshot = await this.readAndValidateBackup(source);

            // Capture the current repository state only after the requested backup
            // has been validated and loaded, so retention cannot invalidate restore.
            const safety = await this.createOnce();
            try {
                await this.restoreFiles(snapshot);
            } catch (error) {
                try {
                    await this.restoreFiles(await this.readAndValidateBackup(safety.directory));
                } catch (rollbackError) {
                    logger.error('backup.restore_rollback_failed', { backupDirectory: source, safetyBackupDirectory: safety.directory, error: rollbackError });
                    throw new Error('Restore failed and automatic rollback was unsuccessful', { cause: error });
                }
                throw new Error('Restore failed; current data was restored from a safety backup', { cause: error });
            }

            const result = {
                backupDirectory: source,
                restoredAt: new Date().toISOString(),
                files: snapshot.manifest.files,
                safetyBackupDirectory: safety.directory,
            };
            logger.info('backup.restored', { backupDirectory: source, safetyBackupDirectory: safety.directory, fileCount: result.files.length });
            return result;
        });
    }

    async list(): Promise<BackupResult[]> {
        const root = this.getBackupRoot();
        await fs.mkdir(root, { recursive: true });
        const entries = (await fs.readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort()
            .reverse();
        const results: BackupResult[] = [];
        for (const name of entries) {
            try {
                const directory = path.join(root, name);
                const { manifest } = await this.readAndValidateBackup(directory);
                results.push({ directory, createdAt: manifest.createdAt, files: manifest.files });
            } catch (error) {
                logger.warn('backup.invalid_ignored', { backup: name, error });
            }
        }
        return results;
    }

    private async createOnce(): Promise<BackupResult> {
        await waitForPendingWrites();
        const repositoryRoot = this.storage.getDirectoryPath();
        const backupRoot = this.getBackupRoot();
        await fs.mkdir(backupRoot, { recursive: true });
        const timestamp = Math.max(Date.now(), this.lastCreatedAtMs + 1);
        this.lastCreatedAtMs = timestamp;
        const createdAt = new Date(timestamp).toISOString();
        const name = createdAt.replace(/[:.]/g, '-');
        const temporary = path.join(backupRoot, `.${name}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
        const destination = path.join(backupRoot, name);
        await fs.mkdir(temporary);
        try {
            const files = (await fs.readdir(repositoryRoot, { withFileTypes: true }))
                .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
                .map((entry) => entry.name)
                .sort();
            const checksums: Record<string, string> = {};
            for (const file of files) {
                const content = await fs.readFile(path.join(repositoryRoot, file));
                JSON.parse(content.toString('utf8'));
                checksums[file] = checksum(content);
                await this.writeSynced(path.join(temporary, file), content);
            }
            const manifest: BackupManifest = { version: 1, createdAt, files, checksums };
            await this.writeSynced(path.join(temporary, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
            await syncDirectory(temporary);
            await fs.rename(temporary, destination);
            await syncDirectory(backupRoot);
            await this.prune(backupRoot);
            logger.info('backup.created', { backupDirectory: destination, fileCount: files.length });
            return { directory: destination, createdAt, files };
        } catch (error) {
            await fs.rm(temporary, { recursive: true, force: true });
            logger.error('backup.create_failed', { error });
            throw new Error('Не вдалося створити резервну копію', { cause: error });
        }
    }

    private async readAndValidateBackup(directory: string): Promise<{ manifest: BackupManifest; contents: Map<string, Buffer> }> {
        const rawManifest: unknown = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (!isManifest(rawManifest)) throw new Error('Invalid backup manifest');
        const contents = new Map<string, Buffer>();
        for (const file of rawManifest.files) {
            if (path.basename(file) !== file || !file.endsWith('.json')) throw new Error(`Invalid backup file name: ${file}`);
            const content = await fs.readFile(path.join(directory, file));
            JSON.parse(content.toString('utf8'));
            if (checksum(content) !== rawManifest.checksums[file]) throw new Error(`Backup checksum mismatch: ${file}`);
            contents.set(file, content);
        }
        return { manifest: rawManifest, contents };
    }

    private async restoreFiles(snapshot: { manifest: BackupManifest; contents: Map<string, Buffer> }): Promise<void> {
        await waitForPendingWrites();
        const root = this.storage.getDirectoryPath();
        await fs.mkdir(root, { recursive: true });
        const staged: Array<{ temporary: string; destination: string }> = [];
        try {
            for (const file of snapshot.manifest.files) {
                const destination = path.join(root, file);
                const temporary = `${destination}.${process.pid}.${Date.now()}.restore.tmp`;
                await this.writeSynced(temporary, snapshot.contents.get(file)!);
                staged.push({ temporary, destination });
            }
            for (const file of staged) await fs.rename(file.temporary, file.destination);
            await syncDirectory(root);
        } catch (error) {
            await Promise.allSettled(staged.map((file) => fs.rm(file.temporary, { force: true })));
            throw error;
        }
    }

    private async resolveBackup(value: string): Promise<string> {
        const root = this.getBackupRoot();
        const candidate = path.resolve(root, value);
        const relative = path.relative(root, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Backup must be inside BACKUP_DIR');
        const stat = await fs.stat(candidate);
        if (!stat.isDirectory()) throw new Error('Backup directory not found');
        return candidate;
    }

    private getBackupRoot(): string {
        return path.resolve(this.configuredRoot || path.join(this.storage.getDirectoryPath(), 'backups'));
    }

    private async writeSynced(file: string, content: Buffer): Promise<void> {
        const handle = await fs.open(file, 'wx');
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    private async prune(root: string): Promise<void> {
        const entries = (await fs.readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort()
            .reverse();
        for (const expired of entries.slice(this.retention)) {
            await fs.rm(path.join(root, expired), { recursive: true });
            logger.info('backup.pruned', { backup: expired });
        }
    }

    private async serialize<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.operationQueue;
        let release!: () => void;
        this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); }
        finally { release(); }
    }
}

function checksum(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

function isManifest(value: unknown): value is BackupManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const manifest = value as Partial<BackupManifest>;
    return manifest.version === 1 && typeof manifest.createdAt === 'string' && Array.isArray(manifest.files) && manifest.files.every((file) => typeof file === 'string') && Boolean(manifest.checksums && typeof manifest.checksums === 'object') && manifest.files.every((file) => typeof manifest.checksums?.[file] === 'string');
}

async function syncDirectory(directory: string): Promise<void> {
    try {
        const handle = await fs.open(directory, 'r');
        try { await handle.sync(); }
        finally { await handle.close(); }
    } catch { /* Directory fsync is unavailable on some platforms. */ }
}
