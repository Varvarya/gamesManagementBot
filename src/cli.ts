import 'dotenv/config';
import path from 'node:path';
import { JsonStorage } from './storage/jsonStorage';
import { RepositoriesContext } from './app/repositories.context';
import { BackupService } from './storage/backup.service';
import { configureLogger, logger, LogLevel } from './utils/logger';
import { resolveClubStorage } from './storage/clubStorageResolver';

async function run(): Promise<void> {
    configureLogger((process.env.LOG_LEVEL?.trim() || 'info') as LogLevel);
    const command = process.argv[2];
    const dataDir = path.resolve(required('DATA_DIR'));
    const resolved = await resolveClubStorage({ dataDir, clubId: required('CLUB_ID') });
    if (!resolved) throw new Error('CLUB_ID does not identify an existing club');
    const storage = new JsonStorage({ dataDir, storageSlug: resolved.storageSlug });
    await storage.ensureReady();
    if (command === 'migrate') {
        const repositories = new RepositoriesContext(storage, process.env.DEFAULT_TIMEZONE?.trim() || 'Europe/Kyiv', resolved);
        await repositories.loadAll();
        logger.info('cli.migration_completed');
        return;
    }
    if (command === 'backup') {
        const result = await new BackupService(storage, 5).create();
        logger.info('cli.backup_created', { directory: result.directory, fileCount: result.files.length });
        return;
    }
    if (command === 'restore') {
        const backup = process.argv[3];
        if (!backup) throw new Error('Usage: cli restore <backup-directory-or-name>');
        const result = await new BackupService(storage, 5).restore(backup);
        logger.info('cli.restore_completed', { backupDirectory: result.backupDirectory, fileCount: result.files.length, safetyBackupDirectory: result.safetyBackupDirectory });
        return;
    }
    throw new Error('Usage: cli migrate|backup|restore <backup-directory-or-name>');
}

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
void run().catch((error) => { logger.error('cli.failed', { error }); process.exitCode = 1; });
