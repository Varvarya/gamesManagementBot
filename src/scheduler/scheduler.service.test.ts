import assert from 'node:assert/strict';
import test from 'node:test';
import { RecurrenceRule } from 'node-schedule';
import { SchedulerService } from './scheduler.service';

test('live recurring scheduler invokes its retained callback once', { timeout: 5_000 }, async () => {
    const scheduler = new SchedulerService();
    const due = new Date(Date.now() + 2_000);
    let calls = 0;
    const called = new Promise<void>((resolve) => {
        scheduler.rescheduleTemplate({
            id: 'live-smoke', dayOfWeek: due.getDay() || 7,
            publishTime: `${two(due.getHours())}:${two(due.getMinutes())}:${two(due.getSeconds())}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            clubId: 'club-test', templateId: 'template-test', slotId: 'slot-test',
        }, async () => { calls += 1; resolve(); });
    });
    try {
        assert.equal(scheduler.getJobsSnapshot()[0]?.isActive, true);
        await called;
        assert.equal(calls, 1);
    } finally { scheduler.cancelAll(); }
});

test('six-field Saturday expression and Europe/Kyiv rule agree at the production instant', () => {
    const rule = new RecurrenceRule();
    rule.dayOfWeek = 6; rule.hour = 14; rule.minute = 10; rule.second = 0; rule.tz = 'Europe/Kyiv';
    assert.equal(rule.nextInvocationDate(new Date('2026-08-22T11:09:59.000Z'))?.toISOString(), '2026-08-22T11:10:00.000Z');
    const scheduler = new SchedulerService();
    scheduler.rescheduleTemplate({ id: 'exact-expression', dayOfWeek: 6, publishTime: '14:10', timezone: 'Europe/Kyiv' }, async () => undefined);
    assert.equal(scheduler.getJobsSnapshot()[0]?.cronExpression, '0 10 14 * * 6');
    scheduler.cancelAll();
});

function two(value: number): string { return String(value).padStart(2, '0'); }
