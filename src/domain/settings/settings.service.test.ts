import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoriesContext } from '../../app/repositories.context';
import { SettingsService } from './settings.service';
import { ClubSettings } from './settings.types';

function harness() {
    let value: ClubSettings = { clubId: 'c', title: 'Club', storageSlug: 'club', timezone: 'Europe/Kyiv', admins: [{ telegramUserId: 1, role: 'owner' }], cleanChatMode: true, createdAt: '', updatedAt: '' };
    const repositories = { settings: { get: async () => value, save: async (next: ClubSettings) => { value = next; return next; } } } as unknown as RepositoriesContext;
    return { service: new SettingsService(repositories), get: () => value };
}

test('settings validates global club fields', async () => {
    const h = harness();
    await assert.rejects(() => h.service.update('timezone', 'Not/AZone'), /часовий пояс/);
    await assert.rejects(() => h.service.update('title', '   '), /порожньою/);
    assert.equal(h.get().title, 'Club');
});

test('admin add/remove works and protects the last admin', async () => {
    const h = harness();
    await h.service.addAdmin(2);
    assert.deepEqual(h.get().admins.map((admin) => admin.telegramUserId), [1, 2]);
    await h.service.removeAdmin(2);
    await assert.rejects(() => h.service.removeAdmin(1), /останнього/);
    assert.equal(h.get().admins.length, 1);
});

test('admin duplicates and invalid ids are rejected without mutation', async () => {
    const h = harness();
    await assert.rejects(() => h.service.addAdmin(1), /уже є/);
    await assert.rejects(() => h.service.addAdmin(-5), /Некоректний/);
    assert.equal(h.get().admins.length, 1);
});
