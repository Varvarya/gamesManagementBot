import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackupService } from './backup.service';
import { JsonStorage } from './jsonStorage';

test('backup copies repository JSON files with a manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-backup-'));
    const storage = new JsonStorage({ dataDir: root, clubId: 'club' });
    await storage.write('settings', { title: 'Club' });
    await storage.write('players', [{ id: 'p' }]);
    const result = await new BackupService(storage, 2).create();
    assert.deepEqual(result.files, ['players.json', 'settings.json']);
    assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'settings.json'), 'utf8')).data.title, 'Club');
    assert.ok((await fs.stat(path.join(result.directory, 'manifest.json'))).isFile());
});

test('backup retention keeps only the newest timestamped snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-retention-'));
    const storage = new JsonStorage({ dataDir: root, clubId: 'club' });
    await storage.write('settings', { title: 'One' });
    const backups = new BackupService(storage, 2);
    await backups.create();
    await storage.write('settings', { title: 'Two' });
    await backups.create();
    await storage.write('settings', { title: 'Three' });
    await backups.create();
    assert.equal((await backups.list()).length, 2);
});

test('restore validates a backup, creates a safety snapshot and restores all files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-restore-'));
    const storage = new JsonStorage({ dataDir: root, clubId: 'club' });
    const backups = new BackupService(storage, 5);
    await storage.write('settings', { title: 'Before' });
    await storage.write('players', [{ id: 'p1' }]);
    const original = await backups.create();
    await storage.write('settings', { title: 'After' });
    await storage.write('players', [{ id: 'p2' }]);

    const restored = await backups.restore(original.directory);
    assert.equal((await storage.read('settings', { title: '' })).title, 'Before');
    assert.deepEqual(await storage.read('players', []), [{ id: 'p1' }]);
    assert.ok(restored.safetyBackupDirectory);
});

test('corrupted backup is rejected without changing repository data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-invalid-restore-'));
    const storage = new JsonStorage({ dataDir: root, clubId: 'club' });
    const backups = new BackupService(storage, 5);
    await storage.write('settings', { title: 'Original' });
    const backup = await backups.create();
    await fs.writeFile(path.join(backup.directory, 'settings.json'), '{broken');
    await assert.rejects(() => backups.restore(backup.directory));
    assert.equal((await storage.read('settings', { title: '' })).title, 'Original');
});
