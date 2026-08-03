import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingService } from './training.service';
import { Training } from './training.types';

const training = (overrides: Partial<Training> = {}): Training => ({
    id: 't', clubId: 'c', chatId: -1, messageId: 42, title: 'Training',
    date: '2026-08-04', startTime: '19:00', endTime: '20:00', placesLimit: 2,
    minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '', updatedAt: '',
    ...overrides,
});

test('persisted participant and status changes trigger the automatic message hook', async () => {
    let stored = training();
    const service = new TrainingService({ trainings: {
        findById: async () => stored,
        save: async (value: Training) => { stored = value; return value; },
    } } as unknown as RepositoriesContext);
    const updates: string[] = [];
    service.setOnChanged(async (value) => { updates.push(value.status); });
    await service.save(stored);
    await service.cancel(stored.id);
    await service.open(stored.id);
    assert.deepEqual(updates, ['open', 'cancelled', 'open']);
});

test('unpublished drafts skip automatic Telegram refresh', async () => {
    let stored = training({ messageId: undefined, status: 'draft' });
    const service = new TrainingService({ trainings: {
        findById: async () => stored,
        save: async (value: Training) => { stored = value; return value; },
    } } as unknown as RepositoriesContext);
    let updates = 0;
    service.setOnChanged(async () => { updates += 1; });
    await service.save(stored);
    assert.equal(updates, 0);
});

test('completion archives training automatically and archived training cannot reopen', async () => {
    let stored = training();
    const service = new TrainingService({ trainings: {
        findById: async () => stored,
        save: async (value: Training) => { stored = value; return value; },
    } } as unknown as RepositoriesContext);
    const completed = await service.finish(stored.id);
    assert.equal(completed.status, 'archived');
    await assert.rejects(() => service.open(stored.id), /read-only/);
});
