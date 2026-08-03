import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoriesContext } from '../../app/repositories.context';
import { TemplateSchedulerService } from '../templates/template-scheduler.service';
import { SuperAdminConfigService } from './super-admin-config.service';

test('invalid import is rejected before settings or templates are changed', async () => {
    let saves = 0;
    const settings = { clubId: 'c', title: 'Original', timezone: 'Europe/Kyiv', chatId: -1, cancelCheckHoursBefore: 4 };
    const repositories = {
        settings: { get: async () => settings, save: async () => { saves++; } },
        templates: { listByClubId: async () => [] },
    } as unknown as RepositoriesContext;
    const service = new SuperAdminConfigService(repositories, {} as TemplateSchedulerService);
    await assert.rejects(() => service.importConfig({ club: { title: 'Changed', timezone: 'Invalid/Zone' } }), /timezone/);
    assert.equal(saves, 0);
    assert.equal(settings.title, 'Original');
});

test('runtime import failure restores settings and template snapshot', async () => {
    let settings: any = { clubId: 'c', title: 'Original', timezone: 'Europe/Kyiv', chatId: -1, cancelCheckHoursBefore: 4 };
    const originalTemplates: any[] = [];
    let restored = false;
    const repositories = {
        settings: { get: async () => settings, save: async (next: any) => { settings = structuredClone(next); return next; } },
        templates: {
            list: async () => originalTemplates,
            listByClubId: async () => [],
            replaceAll: async (items: any[]) => { restored = items.length === 0; },
        },
    } as unknown as RepositoriesContext;
    const scheduler = {
        create: async () => { throw new Error('disk failure'); },
        restore: async () => 0,
    } as unknown as TemplateSchedulerService;
    const backups = { create: async () => ({ directory: '/backup', createdAt: '', files: [] }) };
    const service = new SuperAdminConfigService(repositories, scheduler, backups as any);
    await assert.rejects(() => service.importConfig({ club: { title: 'Changed' }, templates: [{ dayOfWeek: 1, startTime: '18:00', endTime: '19:00', placesLimit: 10, minPlayers: 5, publishDayOfWeek: 7, publishTime: '12:00' }] }), /restored/);
    assert.equal(settings.title, 'Original');
    assert.equal(restored, true);
});

test('snapshot export includes settings, chats, players and full templates', async () => {
    const settings = { clubId: 'c', title: 'Club', timezone: 'Europe/Kyiv', defaultPlacesLimit: 10, defaultMinPlayers: 5, defaultPublishDaysBefore: 1, defaultPublishTime: '12:00', admins: [], cancelCheckHoursBefore: 4, cleanChatMode: false, createdAt: '', updatedAt: '' };
    const repositories = {
        settings: { get: async () => settings },
        chats: { getAll: async () => [{ id: -1, name: 'Chat', enabled: true }] },
        players: { list: async () => [{ id: 'p', displayName: 'Player', aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' }] },
        templates: { list: async () => [{ id: 't', clubId: 'c', chatId: -1, title: 'Training', placesLimit: 10, minPlayers: 5, publishDaysBefore: 1, publishTime: '12:00', slots: [{ id: 's', dayOfWeek: 1, startTime: '18:00', endTime: '19:00', enabled: true }], enabled: true, createdAt: '', updatedAt: '' }] },
    } as unknown as RepositoriesContext;
    const exported = await new SuperAdminConfigService(repositories, {} as TemplateSchedulerService).exportConfig();
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.data?.chats.length, 1);
    assert.equal(exported.data?.players.length, 1);
    assert.equal(exported.data?.templates[0].slots.length, 1);
});

test('snapshot import previews changes and backs up before overwriting all repositories', async () => {
    const calls: string[] = [];
    const currentSettings: any = { clubId: 'c', title: 'Old', timezone: 'Europe/Kyiv', defaultPlacesLimit: 10, defaultMinPlayers: 5, defaultPublishDaysBefore: 1, defaultPublishTime: '12:00', admins: [], cancelCheckHoursBefore: 4, cleanChatMode: false, createdAt: '', updatedAt: '' };
    const incomingSettings = { ...currentSettings, title: 'New' };
    const repositories = {
        settings: { get: async () => currentSettings, save: async () => { calls.push('settings'); } },
        chats: { getAll: async () => [{ id: -1, name: 'Old', enabled: true }], replaceAll: async () => { calls.push('chats'); } },
        players: { list: async () => [{ id: 'old', displayName: 'Old', aliases: [], isConfirmed: true, isActive: true, createdAt: '', updatedAt: '' }], saveAll: async () => { calls.push('players'); } },
        templates: { list: async () => [], replaceAll: async () => { calls.push('templates'); } },
    } as unknown as RepositoriesContext;
    const scheduler = { restore: async () => { calls.push('scheduler'); return 0; } } as unknown as TemplateSchedulerService;
    const backups = { create: async () => { calls.push('backup'); return { directory: '/backup', createdAt: '', files: [] }; } };
    const service = new SuperAdminConfigService(repositories, scheduler, backups as any);
    const config: any = { schemaVersion: 1, data: { settings: incomingSettings, chats: [{ id: -2, name: 'New', enabled: true }], players: [{ id: 'new', displayName: 'New', aliases: [], isConfirmed: false, isActive: true, createdAt: '', updatedAt: '' }], templates: [] } };
    const preview = await service.previewImport(config);
    assert.deepEqual(preview.chats, { current: 1, incoming: 1, added: 1, updated: 0, removed: 1 });
    assert.deepEqual(preview.players, { current: 1, incoming: 1, added: 1, updated: 0, removed: 1 });
    await service.importConfig(config);
    assert.equal(calls[0], 'backup');
    assert.deepEqual(calls.slice(1), ['settings', 'chats', 'players', 'templates', 'scheduler']);
});

test('snapshot schema rejects duplicate ids and unknown template chats before backup', async () => {
    let backedUp = false;
    const service = new SuperAdminConfigService({} as RepositoriesContext, {} as TemplateSchedulerService, { create: async () => { backedUp = true; } } as any);
    const settings: any = { clubId: 'c', title: 'Club', timezone: 'Europe/Kyiv', defaultPlacesLimit: 10, defaultMinPlayers: 5, defaultPublishDaysBefore: 1, defaultPublishTime: '12:00', admins: [], cancelCheckHoursBefore: 4, cleanChatMode: false, createdAt: '', updatedAt: '' };
    const invalid: any = { schemaVersion: 1, data: { settings, chats: [], players: [], templates: [{ id: 't', clubId: 'c', chatId: -1, title: 'T', placesLimit: 10, minPlayers: 5, publishDaysBefore: 1, publishTime: '12:00', slots: [], enabled: true, createdAt: '', updatedAt: '' }] } };
    assert.throws(() => service.parseImportJson(JSON.stringify(invalid)), /unknown chat|schema/);
    assert.equal(backedUp, false);
});
