import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteJson, CURRENT_SCHEMA_VERSION, readReliableJson } from './atomicWrite';

test('atomic JSON uses schema envelope and recovers corrupted original from latest valid backup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-storage-'));
    const file = path.join(root, 'players.json');
    await atomicWriteJson(file, [{ id: 'valid' }]);
    const document = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(document.schemaVersion, CURRENT_SCHEMA_VERSION);
    const backup = path.join(root, 'backups', '2026-01-01');
    await fs.mkdir(backup, { recursive: true });
    await fs.copyFile(file, path.join(backup, 'players.json'));
    await fs.writeFile(file, '{partial');
    const loaded = await readReliableJson(file, (value): value is Array<{ id: string }> => Array.isArray(value));
    assert.equal(loaded.data[0].id, 'valid');
    assert.equal(await fs.readFile(file, 'utf8'), '{partial');
});
