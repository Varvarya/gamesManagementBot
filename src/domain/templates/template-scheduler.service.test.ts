import assert from 'node:assert/strict';
import test from 'node:test';

import { SchedulerService, SchedulerTemplate } from '../../scheduler/scheduler.service';
import { ChatService } from '../chats/chat.service';
import { TrainingPublisherService } from '../trainings/training-publisher.service';
import {
    addCalendarDays,
    calculatePublishDayOfWeek,
    findNearestFutureTrainingDate,
    TemplateSchedulerService,
} from './template-scheduler.service';
import { TemplateService } from './template.service';
import { TrainingTemplate } from './template.types';
import { SettingsRepository } from '../../storage/repositories/settings.repository';

class FakeScheduler {
    readonly jobs = new Map<string, SchedulerTemplate>();
    readonly handlers = new Map<string, () => Promise<void>>();
    rescheduleTemplate(job: SchedulerTemplate, handler: () => Promise<void>): void {
        this.jobs.set(job.id, job);
        this.handlers.set(job.id, handler);
    }
    cancelTemplate(id: string): void {
        this.jobs.delete(id);
        this.handlers.delete(id);
    }
    cancelByPrefix(prefix: string): void {
        for (const id of [...this.jobs.keys()]) {
            if (id.startsWith(prefix)) this.cancelTemplate(id);
        }
    }
    getScheduledTemplateIds(): string[] {
        return [...this.jobs.keys()];
    }
}

function makeTemplate(id: string, chatId: number): TrainingTemplate {
    return {
        id,
        clubId: 'club',
        chatId,
        title: id,
        placesLimit: 20,
        minPlayers: 8,
        publishDaysBefore: 1,
        publishTime: '12:00',
        enabled: true,
        slots: [
            { id: 'one', dayOfWeek: 1, startTime: '19:00', endTime: '21:00', enabled: true },
            { id: 'two', dayOfWeek: 3, startTime: '19:30', endTime: '21:30', enabled: true },
        ],
        createdAt: '',
        updatedAt: '',
    };
}

function makeService(template: TrainingTemplate, scheduler: FakeScheduler) {
    const templates = {
        getRequired: async () => template,
        create: async () => template,
        update: async (_id: string, input: Partial<TrainingTemplate>) => Object.assign(template, input),
        enable: async () => Object.assign(template, { enabled: true }),
        disable: async () => Object.assign(template, { enabled: false }),
        delete: async () => undefined,
    } as unknown as TemplateService;
    const publisher = {
        publishTemplateSlot: async () => undefined,
    } as unknown as TrainingPublisherService;
    const chats = {
        getById: async (id: number) => ({ id, name: String(id), enabled: true }),
    } as unknown as ChatService;
    const settings = {
        get: async () => ({ timezone: 'Europe/Kyiv' }),
    } as unknown as SettingsRepository;
    return new TemplateSchedulerService(
        templates,
        scheduler as unknown as SchedulerService,
        publisher,
        chats,
        settings,
        () => new Date('2026-08-02T08:00:00Z'),
    );
}

test('two enabled slots create two stable jobs and restore without duplicates', async () => {
    const scheduler = new FakeScheduler();
    const template = makeTemplate('alpha', -1001);
    const service = makeService(template, scheduler);
    assert.equal(await service.restore([template]), 2);
    assert.deepEqual([...scheduler.jobs.keys()].sort(), [
        'template:alpha:slot:one',
        'template:alpha:slot:two',
    ]);
    assert.equal(await service.restore([template]), 2);
});

test('two templates in different chats retain independent job keys', async () => {
    const scheduler = new FakeScheduler();
    const first = makeTemplate('first', -1001);
    const second = makeTemplate('second', -1002);
    const service = makeService(first, scheduler);
    await service.restore([first, second]);
    assert.equal(scheduler.jobs.size, 4);
});

test('editing slot time reschedules and disabling slot or template removes jobs', async () => {
    const scheduler = new FakeScheduler();
    const template = makeTemplate('alpha', -1001);
    const service = makeService(template, scheduler);
    await service.restore([template]);
    template.slots[0].publishTime = '09:15';
    await service.update(template.id, { slots: template.slots });
    assert.equal(scheduler.jobs.get('template:alpha:slot:one')?.publishTime, '09:15');
    template.slots[1].enabled = false;
    await service.update(template.id, { slots: template.slots });
    assert.equal(scheduler.jobs.size, 1);
    await service.disable(template.id);
    assert.equal(scheduler.jobs.size, 0);
});

test('Sunday/Monday publication boundary is stable', () => {
    assert.equal(calculatePublishDayOfWeek(1, 1), 7);
    assert.equal(addCalendarDays('2026-08-02', 1), '2026-08-03');
    assert.equal(
        findNearestFutureTrainingDate(
            { date: '2026-08-02', time: '23:00' },
            1,
            '19:00',
        ),
        '2026-08-03',
    );
});
