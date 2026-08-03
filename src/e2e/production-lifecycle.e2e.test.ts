import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Telegram } from 'telegraf';
import { RepositoriesContext } from '../app/repositories.context';
import { ServicesContext } from '../app/services.context';
import { TemplateSchedulerService } from '../domain/templates/template-scheduler.service';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { TrainingCancellationScheduler } from '../scheduler/training-cancellation.scheduler';
import { BackupService } from '../storage/backup.service';
import { JsonStorage } from '../storage/jsonStorage';

test('production lifecycle survives two repository restarts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-e2e-'));
    const backupRoot = path.join(root, 'backups');
    const createRepositories = async () => {
        const storage = new JsonStorage({ dataDir: root, clubId: 'club' });
        await storage.ensureReady();
        const repositories = new RepositoriesContext(storage);
        await repositories.loadAll();
        return { storage, repositories };
    };

    let state = await createRepositories();
    let services = new ServicesContext(state.repositories);
    await services.chats.create({ id: -1001, name: 'Main group' });
    const template = await services.templates.create({ clubId: 'club', chatId: -1001, title: 'Weekly', placesLimit: 2, minPlayers: 1, publishDaysBefore: 1, publishTime: '18:00', enabled: true, slots: [{ dayOfWeek: 1, startTime: '18:00', endTime: '19:00' }, { dayOfWeek: 3, startTime: '19:00', endTime: '20:00' }] });

    state = await createRepositories(); // first restart
    services = new ServicesContext(state.repositories);
    const telegram = { sendMessage: async () => ({ message_id: Math.floor(Math.random() * 100000) + 1 }), editMessageText: async () => true, deleteMessage: async () => true } as unknown as Telegram;
    const publisher = new TrainingPublisherService(telegram, state.repositories, services.trainings, services.trainingMessageRenderer);
    const scheduler = new SchedulerService();
    const templateScheduler = new TemplateSchedulerService(services.templates, scheduler, publisher, services.chats, state.repositories.settings);
    assert.equal(await templateScheduler.restore(await state.repositories.templates.listEnabled()), 2);

    const published = await publisher.publishManual({ clubId: 'club', chatId: -1001, title: 'E2E Training', date: '2099-08-04', startTime: '18:00', endTime: '19:00', placesLimit: 2, minPlayers: 1 });
    const self = await services.registration.registerDetailed({ telegramUser: { id: 1, first_name: 'One' }, chatId: -1001, replyToMessageId: published.messageId, places: 1 });
    await services.registration.registerDetailed({ telegramUser: { id: 1 }, chatId: -1001, replyToMessageId: published.messageId, places: 1, playerName: 'Two' });
    const waiting = await services.registration.registerDetailed({ telegramUser: { id: 1 }, chatId: -1001, replyToMessageId: published.messageId, places: 1, playerName: 'Three' });
    assert.equal(waiting.outcome, 'waitlisted');
    const removed = await services.trainingParticipants.removeParticipant({ trainingId: published.id, playerId: self.training.participants[0].playerId });
    assert.equal(removed.promotedPlayerIds.length, 1);
    const adminRemovedId = removed.training.participants[0].playerId;
    await services.trainingParticipants.removeParticipant({ trainingId: published.id, playerId: adminRemovedId, overrideState: true });

    await templateScheduler.update(template.id, { publishTime: '17:00' });
    assert.equal(scheduler.getScheduledTemplateIds().filter((id) => id.startsWith(`template:${template.id}`)).length, 2);

    const insufficient = await publisher.publishManual({ clubId: 'club', chatId: -1001, title: 'Insufficient', date: '2020-01-01', startTime: '10:00', endTime: '11:00', placesLimit: 5, minPlayers: 2 });
    const cancellation = new TrainingCancellationScheduler(state.repositories, services.trainings, publisher);
    await cancellation.schedule(insufficient);
    assert.equal((await services.trainings.getRequired(insufficient.id)).status, 'cancelled');

    const backup = await new BackupService(state.storage, 5, backupRoot).create();
    assert.ok(backup.files.length >= 6);
    scheduler.cancelAll();
    cancellation.cancelAll();

    state = await createRepositories(); // second restart
    assert.equal((await state.repositories.chats.getAll()).length, 1);
    assert.equal((await state.repositories.templates.list())[0].slots.length, 2);
    assert.equal((await state.repositories.trainings.findById(published.id))?.waitlist.length, 0);
    assert.equal((await state.repositories.trainings.findById(insufficient.id))?.status, 'cancelled');
});
