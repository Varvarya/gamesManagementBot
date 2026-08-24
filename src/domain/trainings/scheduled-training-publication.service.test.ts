import assert from 'node:assert/strict';
import test from 'node:test';

import { SchedulerOneOff, SchedulerService } from '../../scheduler/scheduler.service';
import { ChatService } from '../chats/chat.service';
import { ScheduledTrainingPublicationService } from './scheduled-training-publication.service';
import { TrainingPublisherService } from './training-publisher.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';
import { PublicationTrace } from './publication-trace';

const base = (): Training => ({ id: 'training', clubId: 'club', chatId: -100, title: 'Training', date: '2026-08-20', startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 4, status: 'draft', participants: [], waitlist: [], scheduledPublicationAt: '2026-08-19T18:10', createdAt: '', updatedAt: '' });

function fixture(now = '2026-08-19T12:00:00.000Z') {
    let value = base(); let publications = 0; let fail = false; const traces: PublicationTrace[] = [];
    const jobs = new Map<string, { input: SchedulerOneOff; run: () => Promise<void> }>();
    const scheduler = { cancelTemplate: (id: string) => jobs.delete(id), rescheduleOneOff: (input: SchedulerOneOff, run: () => Promise<void>) => { jobs.set(input.id, { input, run }); } } as unknown as SchedulerService;
    const trainings = { getRequired: async () => value } as unknown as TrainingService;
    const publisher = { publishExistingDraft: async (_id: string, trace: PublicationTrace) => { traces.push(trace); publications++; if (fail) throw new Error('telegram'); value = { ...value, status: 'open', messageId: 42, publishedAt: 'now', scheduledPublicationAt: undefined }; return value; } } as unknown as TrainingPublisherService;
    const chats = { getById: async () => ({ id: -100, enabled: true }) } as unknown as ChatService;
    const service = new ScheduledTrainingPublicationService(scheduler, { list: async () => [value] }, trainings, publisher, chats, { get: async () => ({ timezone: 'Europe/Kyiv' }) }, () => new Date(now));
    return { service, jobs, traces, get value() { return value; }, set value(next: Training) { value = next; }, get publications() { return publications; }, fail() { fail = true; } };
}

test('future publication is scheduled in Europe/Kyiv and firing reloads and publishes it', async () => {
    const f = fixture();
    assert.equal(await f.service.schedule('training'), 'scheduled');
    const job = f.jobs.get('club:club:training:training')!;
    assert.deepEqual(job.input, {
        id: 'club:club:training:training', date: '2026-08-19', time: '18:10', timezone: 'Europe/Kyiv',
        clubId: 'club', templateId: undefined, slotId: undefined, trainingDate: '2026-08-20',
        trainingStartAt: '2026-08-20T18:00', triggerSource: 'cron',
    });
    await job.run();
    assert.equal(f.publications, 1);
    assert.equal(f.value.status, 'open');
    assert.equal(f.traces[0].triggerSource, 'cron');
});

test('restart restores a future job', async () => {
    const f = fixture();
    assert.equal(await f.service.restore(), 1);
    assert.equal(f.jobs.size, 1);
});

test('startup after openAt recovers the exact 20.08 18:00 case immediately', async () => {
    const f = fixture('2026-08-20T08:00:00.000Z');
    assert.equal(await f.service.restore(), 0);
    assert.equal(f.publications, 1);
    assert.equal(f.value.messageId, 42);
    assert.equal(f.traces[0].triggerSource, 'startup_recovery');
});

test('published and cancelled trainings are skipped and never duplicated', async () => {
    const f = fixture('2026-08-20T08:00:00.000Z');
    f.value = { ...f.value, status: 'open', messageId: 42, publishedAt: 'now' };
    await f.service.restore();
    f.value = { ...base(), status: 'cancelled' };
    await f.service.restore();
    assert.equal(f.publications, 0);
});

test('changed openAt replaces the job and Telegram failure leaves the draft recoverable', async () => {
    const f = fixture();
    await f.service.schedule('training');
    f.value = { ...f.value, scheduledPublicationAt: '2026-08-19T19:10' };
    await f.service.schedule('training');
    assert.equal(f.jobs.size, 1);
    assert.equal([...f.jobs.values()][0].input.time, '19:10');
    f.fail();
    await assert.rejects([...f.jobs.values()][0].run, /telegram/);
    assert.equal(f.value.status, 'draft');
    assert.equal(f.value.messageId, undefined);
    assert.equal(f.value.scheduledPublicationAt, '2026-08-19T19:10');
});
