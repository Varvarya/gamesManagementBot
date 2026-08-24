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
    cancelAll(): void {
        this.jobs.clear();
        this.handlers.clear();
    }
    getScheduledTemplateIds(): string[] {
        return [...this.jobs.keys()];
    }
    getJobsSnapshot(): Array<{ jobId: string; nextRunAt?: string }> {
        return [...this.jobs.keys()].map((jobId) => ({ jobId }));
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

function makeService(template: TrainingTemplate, scheduler: FakeScheduler, options: { now?: Date; published?: Record<string, unknown>[] } = {}) {
    const templates = {
        getRequired: async () => template,
        create: async () => template,
        update: async (_id: string, input: Partial<TrainingTemplate>) => Object.assign(template, input),
        enable: async () => Object.assign(template, { enabled: true }),
        disable: async () => Object.assign(template, { enabled: false }),
        delete: async () => undefined,
    } as unknown as TemplateService;
    const publisher = {
        publishTemplateSlot: async (input: Record<string, unknown>) => {
            options.published?.push(input);
            return { id: 'training', status: 'open', messageId: 42 };
        },
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
        () => options.now ?? new Date('2026-08-02T08:00:00Z'),
    );
}

test('two enabled slots create two stable jobs and restore without duplicates', async () => {
    const scheduler = new FakeScheduler();
    const template = makeTemplate('alpha', -1001);
    const service = makeService(template, scheduler);
    assert.equal(await service.restore([template]), 2);
    assert.deepEqual([...scheduler.jobs.keys()].sort(), [
        'club:club:template:alpha:slot:one',
        'club:club:template:alpha:slot:two',
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
    assert.equal(scheduler.jobs.get('club:club:template:alpha:slot:one')?.publishTime, '09:15');
    template.slots[1].enabled = false;
    await service.update(template.id, { slots: template.slots });
    assert.equal(scheduler.jobs.size, 1);
    await service.disable(template.id);
    assert.equal(scheduler.jobs.size, 0);
});

test('startup reconciliation publishes a missed occurrence that is still in the future', async () => {
    const scheduler = new FakeScheduler();
    const template = makeTemplate('alpha', -1001);
    const published: Record<string, unknown>[] = [];
    // Sunday 13:00 Kyiv: Monday's Sunday 12:00 publication was missed,
    // while the Monday 19:00 training is still in the future.
    const service = makeService(template, scheduler, { now: new Date('2026-08-02T10:00:00Z'), published });

    await service.restore([template], { reconcileMissed: true });

    assert.equal(published.length, 1);
    assert.equal(published[0].slotId, 'one');
    assert.equal(published[0].date, '2026-08-03');
    assert.equal((published[0].trace as { triggerSource?: string })?.triggerSource, 'startup_recovery');
});

test('cron publication uses the persisted template chat and carries one job correlation identity', async () => {
    const scheduler = new FakeScheduler();
    const template = makeTemplate('two-chat-template', -2002);
    const published: Record<string, unknown>[] = [];
    const service = makeService(template, scheduler, { now: new Date('2026-08-02T08:00:00Z'), published });
    await service.restore([template]);

    const jobId = 'club:club:template:two-chat-template:slot:one';
    await scheduler.handlers.get(jobId)!();

    assert.equal(published.length, 1);
    assert.equal(published[0].chatId, -2002);
    assert.deepEqual(published[0].trace, { jobId, publicationAttemptId: jobId, triggerSource: 'cron' });
});

test('live scheduler reaches automatic publication without restart or manual action', { timeout: 5_000 }, async () => {
    const scheduler = new SchedulerService();
    const due = new Date(Date.now() + 2_000);
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(due);
    const part = (type: Intl.DateTimeFormatPartTypes) => local.find((item) => item.type === type)!.value;
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    const publishTime = `${part('hour')}:${part('minute')}:${part('second')}`;
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    const template = makeTemplate('live', -2002);
    template.publishDaysBefore = 0; template.publishTime = publishTime;
    template.slots = [{ id: 'live-slot', dayOfWeek, startTime: '23:59', endTime: '23:59', publishDaysBefore: 0, publishTime, enabled: true }];
    let publishedInput: Record<string, unknown> | undefined;
    const published = new Promise<void>((resolve) => {
        const service = new TemplateSchedulerService(
            { getRequired: async () => template } as unknown as TemplateService,
            scheduler,
            { publishTemplateSlot: async (input: Record<string, unknown>) => { publishedInput = input; resolve(); return { id: 'training-live', status: 'open', messageId: 42 }; } } as unknown as TrainingPublisherService,
            { getById: async (id: number) => id === -2002 ? { id, name: 'Chat B', enabled: true } : undefined } as unknown as ChatService,
            { get: async () => ({ clubId: 'club', timezone: 'Europe/Kyiv' }) } as unknown as SettingsRepository,
        );
        void service.restore([template]);
    });
    try {
        await published;
        assert.equal(publishedInput?.chatId, -2002);
        assert.equal((publishedInput?.trace as { triggerSource?: string })?.triggerSource, 'cron');
    } finally { scheduler.cancelAll(); }
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
