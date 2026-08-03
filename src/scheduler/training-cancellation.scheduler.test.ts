import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoriesContext } from '../app/repositories.context';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { TrainingService } from '../domain/trainings/training.service';
import { Training } from '../domain/trainings/training.types';
import { TrainingCancellationScheduler } from './training-cancellation.scheduler';

function value(status: Training['status'] = 'open'): Training {
    return { id: 't', clubId: 'c', chatId: -1, title: 'T', date: '2020-01-01', startTime: '10:00', endTime: '11:00', placesLimit: 10, minPlayers: 2, status, participants: [], waitlist: [], createdAt: '', updatedAt: '' };
}

test('automatic cancellation cancels and notifies once', async () => {
    const training = value();
    let cancellations = 0, refreshes = 0, notifications = 0;
    const repositories = { settings: { get: async () => ({ cancelCheckHoursBefore: 4 }) }, trainings: { listActive: async () => [training] } } as unknown as RepositoriesContext;
    const trainings = { getRequired: async () => training, cancel: async () => { cancellations++; training.status = 'cancelled'; return training; } } as unknown as TrainingService;
    const publisher = { refreshMessage: async () => { refreshes++; }, notifyCancellation: async () => { notifications++; } } as unknown as TrainingPublisherService;
    const scheduler = new TrainingCancellationScheduler(repositories, trainings, publisher);
    await scheduler.schedule(training);
    await scheduler.schedule(training);
    assert.deepEqual([cancellations, refreshes, notifications], [1, 1, 1]);
});

test('closed and completed trainings are never automatically cancelled', async () => {
    for (const status of ['closed', 'finished'] as const) {
        const training = value(status);
        let cancellations = 0;
        const scheduler = new TrainingCancellationScheduler({ settings: { get: async () => ({ cancelCheckHoursBefore: 4 }) } } as unknown as RepositoriesContext, { getRequired: async () => training, cancel: async () => { cancellations++; return training; } } as unknown as TrainingService, {} as TrainingPublisherService);
        await scheduler.schedule(training);
        assert.equal(cancellations, 0);
    }
});
