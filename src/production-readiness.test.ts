import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BaseJsonRepository } from './storage/repositories/baseJsonRepository';
import { assertCallbackDataValid } from './bot/callback-data';
import { isTelegramUserClubAdmin } from './domain/settings/club-admin-authorization';
import { TrainingService } from './domain/trainings/training.service';
import { TrainingParticipantsService } from './domain/trainings/training-participants.service';
import { RepositoriesContext } from './app/repositories.context';
import { JsonStorage } from './storage/jsonStorage';
import { UpcomingTrainingsQueryService } from './domain/trainings/upcoming-trainings-query.service';
import { ScheduleOccurrenceResolver } from './domain/schedule-exceptions/schedule-occurrence.resolver';
import { TrainingTemplate } from './domain/templates/template.types';
import { ServicesContext } from './app/services.context';
import { TemplateSchedulerService } from './domain/templates/template-scheduler.service';
import { SchedulerService, SchedulerTemplate } from './scheduler/scheduler.service';
import { TrainingPublisherService } from './domain/trainings/training-publisher.service';

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-readiness-'));
    const storage = new JsonStorage({ dataDir: root, storageSlug: 'club-a' });
    await storage.ensureReady();
    const repositories = new RepositoriesContext(storage, 'Europe/Kyiv', { clubId: 'club-a', title: 'A', storageSlug: 'club-a' });
    await repositories.loadAll();
    return { root, repositories };
}

test('authorization normalizes IDs and accepts owners and admins', () => {
    const admins = [{ telegramUserId: '42', role: 'owner' }, { telegramUserId: 43, role: 'admin' }];
    assert.equal(isTelegramUserClubAdmin(admins, 42), true);
    assert.equal(isTelegramUserClubAdmin(admins, '43'), true);
    assert.equal(isTelegramUserClubAdmin(admins, 44), false);
});

test('callback_data enforces Telegram UTF-8 byte limit', () => {
    assert.equal(assertCallbackDataValid('x'.repeat(64)), 'x'.repeat(64));
    assert.throws(() => assertCallbackDataValid('🏸'.repeat(17)), /bytes=68/);
});

test('repository returns isolated values and persists an explicit mutation', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-repo-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'entities.json');
    const repository = new BaseJsonRepository<{ id: string; nested: { value: number } }>(file);
    await repository.save({ id: 'one', nested: { value: 1 } });
    const leaked = (await repository.list())[0];
    leaked.nested.value = 99;
    assert.equal((await repository.findById('one'))?.nested.value, 1);
    assert.match(await readFile(file, 'utf8'), /"value": 1/);
});

test('capacity uses places, keeps an entry whole, decrements, and skips oversized waitlist entries', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const trainings = new TrainingService(repositories);
    const participants = new TrainingParticipantsService(trainings);
    const draft = await trainings.createDraft({ clubId: 'club-a', chatId: -1, title: 'Game', date: '2030-01-01', startTime: '18:00', endTime: '20:00', placesLimit: 6, minPlayers: 0 });
    await trainings.publish({ trainingId: draft.id, messageId: 1 });
    await participants.addParticipant({ trainingId: draft.id, playerId: 'a', displayName: 'A', places: 4, source: 'telegram' });
    assert.equal((await participants.addParticipant({ trainingId: draft.id, playerId: 'b', displayName: 'B', places: 3, source: 'telegram' })).outcome, 'waitlisted');
    await participants.addParticipant({ trainingId: draft.id, playerId: 'c', displayName: 'C', places: 1, source: 'telegram' });
    await participants.addParticipant({ trainingId: draft.id, playerId: 'd', displayName: 'D', places: 2, source: 'telegram' });
    const result = await participants.removeParticipant({ trainingId: draft.id, playerId: 'a', requestedPlacesToRemove: 1 });
    assert.deepEqual(result.promotedPlayerIds, ['d']);
    assert.equal(result.training.participants.reduce((sum, entry) => sum + entry.places, 0), 6);
    assert.deepEqual(result.training.waitlist.map((entry) => entry.playerId), ['b']);
});

test('training lifecycle rejects impossible transitions', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = new TrainingService(repositories);
    const draft = await service.createDraft({ clubId: 'club-a', chatId: -1, title: 'Game', date: '2030-01-01', startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 8 });
    await assert.rejects(() => service.finish(draft.id), /Invalid training transition/);
    await service.publish({ trainingId: draft.id, messageId: 1 });
    await service.close(draft.id);
    assert.equal((await service.finish(draft.id)).status, 'finished');
    assert.equal((await service.archive(draft.id)).status, 'archived');
});

test('upcoming query is read-only, detects missed publication, and replaces occurrence with created training', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await repositories.chats.create({ id: -100, name: 'Основний', enabled: true });
    const schedule: TrainingTemplate = {
        id: 'schedule', clubId: 'club-a', chatId: -100, title: 'Вечірні тренування', placesLimit: 12, minPlayers: 4,
        publishDaysBefore: 1, publishTime: '12:00', enabled: true,
        slots: [{ id: 'monday', dayOfWeek: 1, startTime: '18:00', endTime: '20:00', enabled: true }],
        createdAt: '', updatedAt: '',
    };
    await repositories.templates.save(schedule);
    const query = new UpcomingTrainingsQueryService(repositories, new ScheduleOccurrenceResolver(), () => new Date('2026-08-16T12:00:00Z'));
    const storageFiles = ['templates.json', 'trainings.json', 'schedule-exceptions.json'];
    const before = await Promise.all(storageFiles.map((name) => readFile(path.join(root, 'club-a', name), 'utf8')));

    const missed = await query.list(3);

    assert.equal(missed.length, 1);
    assert.equal(missed[0].type, 'MISSED_PUBLICATION');
    assert.deepEqual(await Promise.all(storageFiles.map((name) => readFile(path.join(root, 'club-a', name), 'utf8'))), before);

    const trainings = new TrainingService(repositories);
    const draft = await trainings.createDraft({ clubId: 'club-a', chatId: -100, templateId: schedule.id, templateSlotId: 'monday', title: schedule.title,
        date: '2026-08-17', startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 4 });
    await trainings.publish({ trainingId: draft.id, messageId: 42 });
    const created = await query.list(3);
    assert.equal(created.length, 1);
    assert.equal(created[0].type, 'CREATED_TRAINING');
    assert.equal(created[0].training?.id, draft.id);
});

test('upcoming query represents a paused schedule only once', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await repositories.templates.save({
        id: 'paused', clubId: 'club-a', chatId: -100, title: 'Денні тренування', placesLimit: 12, minPlayers: 4,
        publishDaysBefore: 1, publishTime: '12:00', enabled: false,
        slots: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ id: `day-${dayOfWeek}`, dayOfWeek, startTime: '12:00', endTime: '14:00', enabled: true })),
        createdAt: '', updatedAt: '',
    });
    const items = await new UpcomingTrainingsQueryService(repositories, new ScheduleOccurrenceResolver(), () => new Date('2026-08-16T08:00:00Z')).list(7);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'PAUSED_SCHEDULE');
});

test('opening upcoming repeatedly leaves automatic publication job intact and it still fires once', async (t) => {
    const { root, repositories } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await repositories.chats.create({ id: -100, name: 'Основний', enabled: true });
    const template: TrainingTemplate = {
        id: 'automatic', clubId: 'club-a', chatId: -100, title: 'Автоматичне', placesLimit: 12, minPlayers: 4,
        publishDaysBefore: 1, publishTime: '18:20', enabled: true,
        slots: [{ id: 'monday', dayOfWeek: 1, startTime: '18:00', endTime: '20:00', enabled: true }], createdAt: '', updatedAt: '',
    };
    await repositories.templates.save(template);
    const services = new ServicesContext(repositories);
    const jobs = new Map<string, () => Promise<void>>();
    const fakeScheduler = {
        cancelAll: () => jobs.clear(),
        cancelTemplate: (id: string) => jobs.delete(id),
        cancelByPrefix: (prefix: string) => { for (const id of [...jobs.keys()]) if (id.startsWith(prefix)) jobs.delete(id); },
        rescheduleTemplate: (job: SchedulerTemplate, handler: () => Promise<void>) => { jobs.set(job.id, handler); },
        getScheduledTemplateIds: () => [...jobs.keys()],
        getJobsSnapshot: () => [...jobs.keys()].map((jobId) => ({ jobId })),
    } as unknown as SchedulerService;
    let publications = 0;
    const publisher = { publishTemplateSlot: async () => { publications += 1; return { id: 'training', status: 'open', messageId: 42 }; } } as unknown as TrainingPublisherService;
    const fixedNow = () => new Date('2026-08-16T08:00:00Z');
    const automatic = new TemplateSchedulerService(services.templates, fakeScheduler, publisher, services.chats, repositories.settings, fixedNow);
    await automatic.restore([template]);
    const jobIds = [...jobs.keys()];
    const query = new UpcomingTrainingsQueryService(repositories, services.occurrenceResolver, fixedNow);

    assert.equal((await query.list())[0].type, 'FUTURE_OCCURRENCE');
    assert.equal((await query.list())[0].type, 'FUTURE_OCCURRENCE');

    assert.deepEqual([...jobs.keys()], jobIds);
    await jobs.get(jobIds[0])!();
    assert.equal(publications, 1);
});
