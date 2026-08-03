import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';
import { BackupService } from '../../../storage/backup.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { AdminSettingsHandler } from './admin-settings.handler';

test('status screen shows live operational counters and recent activity', async () => {
    let rendered = '';
    const services = {
        settings: { get: async () => ({ title: 'Club', timezone: 'Europe/Kyiv' }) },
        scheduler: { getScheduledTemplateIds: () => ['template:1'] },
        repositories: {
            chats: { getAll: async () => [{ enabled: true }, { enabled: false }] },
            templates: { list: async () => [{ enabled: true }, { enabled: false }] },
            trainings: {
                listActive: async () => [{ id: 'active' }],
                list: async () => [{ date: '2026-08-03', startTime: '18:00', publishedAt: '2026-08-02T12:00:00.000Z' }],
            },
            players: { list: async () => [{ isActive: true }, { isActive: false }] },
        },
        adminUi: { show: async (_ctx: Context, text: string) => { rendered = text; } },
    } as unknown as ServicesContext;
    const cancellationScheduler = { getJobCount: () => 2 } as TrainingCancellationScheduler;
    const backups = { list: async () => [{ directory: '/backup', createdAt: '2026-08-02T11:00:00.000Z', files: [] }] } as unknown as BackupService;
    const handler = new AdminSettingsHandler(services, cancellationScheduler, backups);

    await handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.SettingsStatus);

    assert.match(rendered, /Чати: 1 увімкнено \/ 2 всього/);
    assert.match(rendered, /Розклади: 1 увімкнено \/ 2 всього/);
    assert.match(rendered, /Активні тренування: 1/);
    assert.match(rendered, /Завдання планувальника: 3/);
    assert.match(rendered, /Гравці: 1 активних \/ 2 всього/);
    assert.match(rendered, /Резервні копії: 1/);
    assert.match(rendered, /Остання публікація: 2026-08-03 о 18:00/);
});
