import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateTrainingTemplates } from './template.migration';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStorage } from '../../storage/jsonStorage';
import { RepositoriesContext } from '../../app/repositories.context';

test('legacy single-slot and gameChat template migration is idempotent', () => {
    const legacy = [{ id: 'legacy', clubId: 'c', gameChat: { id: -100 }, title: 'T', dayOfWeek: 1, startTime: '18:00', endTime: '19:00', placesLimit: 10, minPlayers: 5, publishDayOfWeek: 7, publishTime: '12:00', createdAt: '', updatedAt: '' }];
    const first = migrateTrainingTemplates(legacy);
    assert.deepEqual(migrateTrainingTemplates(first), first);
    assert.equal(first[0].chatId, -100);
    assert.equal(first[0].slots[0].id, 'slot_legacy_0');
    assert.equal(first[0].enabled, true);
    assert.equal(first[0].slots[0].enabled, true);
});

test('template migration refuses to silently discard invalid entries', () => {
    assert.throws(() => migrateTrainingTemplates([{ id: 'unknown' }]), /refused to discard/);
});

test('legacy club defaults are copied to templates before being removed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gamesbot-settings-migration-'));
    try {
        const storage = new JsonStorage({ dataDir: directory, clubId: 'club' });
        await storage.write('settings', {
            clubId: 'club', title: 'Club', timezone: 'Europe/Kyiv', admins: [], cleanChatMode: true,
            defaultPlacesLimit: 24, defaultMinPlayers: 11, defaultPublishDaysBefore: 3,
            defaultPublishTime: '14:30', cancelCheckHoursBefore: 6, createdAt: '', updatedAt: '',
        });
        await storage.write('templates', [{
            id: 't', clubId: 'club', chatId: -1, title: 'Training',
            slots: [{ id: 's', dayOfWeek: 1, startTime: '18:00', endTime: '20:00', enabled: true }],
            enabled: true, createdAt: '', updatedAt: '',
        }]);

        const repositories = new RepositoriesContext(storage);
        await repositories.loadAll();
        const template = (await repositories.templates.list())[0];
        const settings = await repositories.settings.get() as unknown as Record<string, unknown>;

        assert.equal(template.placesLimit, 24);
        assert.equal(template.minPlayers, 11);
        assert.equal(template.publishDaysBefore, 3);
        assert.equal(template.publishTime, '14:30');
        assert.equal(template.cancelCheckHoursBefore, 6);
        assert.equal(settings.defaultPlacesLimit, undefined);
        assert.equal(settings.cancelCheckHoursBefore, undefined);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
