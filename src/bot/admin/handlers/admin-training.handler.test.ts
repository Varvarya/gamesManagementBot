import assert from 'node:assert/strict';
import test from 'node:test';
import { Training } from '../../../domain/trainings/training.types';
import { compareTrainingStart } from './admin-training.handler';

function training(id: string, date: string, startTime: string): Training {
    return { id, clubId: 'c', chatId: -1, title: id, date, startTime, endTime: '23:00', placesLimit: 1, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '', updatedAt: '' };
}

test('active trainings sort by real date and start time', () => {
    const values = [training('late', '2026-10-02', '09:00'), training('second', '2026-09-30', '20:00'), training('first', '2026-09-30', '08:00')];
    values.sort(compareTrainingStart);
    assert.deepEqual(values.map((item) => item.id), ['first', 'second', 'late']);
});
