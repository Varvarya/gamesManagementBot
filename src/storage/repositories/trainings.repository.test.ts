import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Training } from '../../domain/trainings/training.types';
import { TrainingsRepository } from './trainings.repository';

const training = (id: string, title: string, date: string, status: Training['status']): Training => ({ id, clubId: 'c', chatId: -1, title, date, startTime: '18:00', endTime: '19:00', placesLimit: 10, minPlayers: 2, status, participants: [], waitlist: [], createdAt: '', updatedAt: '' });

test('archive month and search filters never include active trainings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gamesbot-archive-'));
    const repository = new TrainingsRepository(path.join(root, 'trainings.json'));
    await repository.save(training('a', 'Вечірнє тренування', '2026-08-04', 'archived'));
    await repository.save(training('legacy', 'Ранкове', '2026-08-10', 'finished'));
    await repository.save(training('other', 'Вечірнє', '2026-09-04', 'archived'));
    await repository.save(training('active', 'Вечірнє', '2026-08-05', 'open'));

    assert.deepEqual((await repository.listArchived({ month: '2026-08' })).map((item) => item.id), ['a', 'legacy']);
    assert.deepEqual((await repository.listArchived({ query: 'вечірнє' })).map((item) => item.id), ['a', 'other']);
    assert.deepEqual((await repository.listArchived({ query: '2026-08-10' })).map((item) => item.id), ['legacy']);
    assert.deepEqual((await repository.listActive()).map((item) => item.id), ['active']);
});
