import schedule, {
    Job,
    RecurrenceRule,
} from 'node-schedule';
import { logger } from '../utils/logger';

export type SchedulerTemplate = {
    id: string;
    dayOfWeek: number;
    publishTime: string;
    timezone: string;
    clubId?: string;
    templateId?: string;
    slotId?: string;
    trainingDate?: string;
    trainingStartAt?: string;
    scheduledFor?: string;
    currentTime?: string;
    triggerSource?: 'cron';
};
export type SchedulerOneOff = { id: string; date: string; time: string; timezone: string; clubId?: string; templateId?: string; slotId?: string; trainingDate?: string; trainingStartAt?: string; triggerSource?: 'cron' };

type SchedulerPublishHandler =
    () => Promise<void>;

export class SchedulerService {
    private readonly jobs =
        new Map<string, Job>();
    private readonly metadata = new Map<string, { clubId?: string; templateId?: string; slotId?: string; timezone: string; cronExpression?: string; localPublishAt?: string; scheduledFor?: string; expectedNextRunAt?: string; triggerSource?: string }>();

    rescheduleTemplate(
        template: SchedulerTemplate,
        onPublish: SchedulerPublishHandler,
    ): void {
        this.cancelTemplate(template.id, 'reschedule');

        const rule =
            this.createRule(
                template,
            );
        const expectedNextRunAt = rule.nextInvocationDate(new Date())?.toISOString();

        const job =
            schedule.scheduleJob(
                rule,
                async (fireDate: Date) => {
                    const actualStartedAt = new Date();
                    const started = Date.now();
                    logger.info('scheduler.job_started', { jobId: template.id, publicationAttemptId: template.id, clubId: template.clubId, templateId: template.templateId, slotId: template.slotId, scheduledFor: fireDate.toISOString(), actualStartedAt: actualStartedAt.toISOString(), delayMs: actualStartedAt.getTime() - fireDate.getTime(), triggerSource: 'cron' });
                    try {
                        await onPublish();
                        logger.info('scheduler.job_completed', { jobId: template.id, publicationAttemptId: template.id, clubId: template.clubId, templateId: template.templateId, slotId: template.slotId, triggerSource: 'cron', durationMs: Date.now() - started, outcome: 'completed' });
                    } catch (error) {
                        logger.error('scheduler.job_failed', { jobId: template.id, publicationAttemptId: template.id, clubId: template.clubId, templateId: template.templateId, slotId: template.slotId, triggerSource: 'cron', durationMs: Date.now() - started, stage: 'scheduled_callback', ...this.errorFields(error) });
                    }
                },
            );

        if (!job) {
            logger.error('scheduler.job_registration_failed', { jobId: template.id, dayOfWeek: template.dayOfWeek, publishTime: template.publishTime, timezone: template.timezone, jobRegistered: false });
            throw new Error(
                `Failed to schedule job: ${template.id}`,
            );
        }

        this.jobs.set(
            template.id,
            job,
        );
        const cronDay = this.toNodeScheduleDay(template.dayOfWeek);
        const [hour, minute, second] = this.parseTime(template.publishTime);
        const cronExpression = `${second} ${minute} ${hour} * * ${cronDay}`;
        const nextRun = job.nextInvocation();
        const libraryNextRunAt = nextRun?.toISOString();
        const isActive = job.pendingInvocations.length > 0;
        this.metadata.set(template.id, { clubId: template.clubId, templateId: template.templateId, slotId: template.slotId, timezone: template.timezone, cronExpression, localPublishAt: nextRun ? this.formatLocal(nextRun, template.timezone) : undefined, scheduledFor: template.scheduledFor, expectedNextRunAt, triggerSource: 'cron' });
        logger.info('scheduler.job_scheduled', { jobId: template.id, publicationAttemptId: template.id, clubId: template.clubId, templateId: template.templateId, slotId: template.slotId, trainingDate: template.trainingDate, trainingStartAt: template.trainingStartAt, openAt: template.scheduledFor, scheduledFor: template.scheduledFor, currentTime: template.currentTime, timezone: template.timezone, cronExpression, schedulerImplementation: 'node-schedule', schedulerVersion: '2.1.1', expectedNextRunAt, libraryNextRunAt, delayUntilExecutionMs: nextRun ? nextRun.getTime() - Date.now() : undefined, pendingInvocationCount: job.pendingInvocations.length, running: this.runningCount(job), isActive, triggerSource: 'cron', jobRegistered: isActive });
        if (!isActive) {
            this.jobs.delete(template.id);
            this.metadata.delete(template.id);
            throw new Error(`Scheduled job has no pending invocation: ${template.id}`);
        }
    }

    rescheduleOneOff(input: SchedulerOneOff, onPublish: SchedulerPublishHandler): void {
        this.cancelTemplate(input.id, 'reschedule');
        const [year, month, day] = input.date.split('-').map(Number);
        const [hour, minute, second] = this.parseTime(input.time);
        const rule = new schedule.RecurrenceRule();
        rule.year = year; rule.month = month - 1; rule.date = day; rule.hour = hour; rule.minute = minute; rule.second = second; rule.tz = input.timezone;
        const job = schedule.scheduleJob(rule, async (fireDate: Date) => {
            const started = Date.now();
            logger.info('scheduler.job_started', { jobId: input.id, publicationAttemptId: input.id, clubId: input.clubId, templateId: input.templateId, slotId: input.slotId, scheduledFor: fireDate.toISOString(), actualStartedAt: new Date(started).toISOString(), delayMs: started - fireDate.getTime(), triggerSource: 'cron' });
            try {
                await onPublish();
                logger.info('scheduler.job_completed', { jobId: input.id, publicationAttemptId: input.id, triggerSource: 'cron', durationMs: Date.now() - started, outcome: 'completed' });
            } catch (error) {
                logger.error('scheduler.job_failed', { jobId: input.id, publicationAttemptId: input.id, clubId: input.clubId, templateId: input.templateId, slotId: input.slotId, triggerSource: 'cron', durationMs: Date.now() - started, stage: 'scheduled_callback', ...this.errorFields(error) });
            } finally {
                this.jobs.delete(input.id);
                this.metadata.delete(input.id);
            }
        });
        if (!job) {
            logger.info('scheduler.one_off_not_registered', { jobId: input.id, date: input.date, time: input.time, timezone: input.timezone, jobRegistered: false, reason: 'past_due' });
            return; // Past one-off jobs are reconciled explicitly and never replayed on restore.
        }
        this.jobs.set(input.id, job);
        const libraryNextRunAt = job.nextInvocation()?.toISOString();
        this.metadata.set(input.id, { clubId: input.clubId, templateId: input.templateId, slotId: input.slotId, timezone: input.timezone, localPublishAt: `${input.date}T${input.time}`, scheduledFor: `${input.date}T${input.time}`, expectedNextRunAt: libraryNextRunAt, triggerSource: 'cron' });
        logger.info('scheduler.job_scheduled', { jobId: input.id, publicationAttemptId: input.id, clubId: input.clubId, templateId: input.templateId, slotId: input.slotId, trainingDate: input.trainingDate, trainingStartAt: input.trainingStartAt, openAt: `${input.date}T${input.time}`, scheduledFor: `${input.date}T${input.time}`, timezone: input.timezone, schedulerRepresentation: 'one_off_recurrence_rule', schedulerImplementation: 'node-schedule', schedulerVersion: '2.1.1', libraryNextRunAt, delayUntilExecutionMs: job.nextInvocation() ? job.nextInvocation()!.getTime() - Date.now() : undefined, pendingInvocationCount: job.pendingInvocations.length, running: this.runningCount(job), isActive: job.pendingInvocations.length > 0, triggerSource: 'cron', jobRegistered: true });
    }

    cancelTemplate(templateId: string, reason = 'explicit_cancel'): void {
        const job =
            this.jobs.get(
                templateId,
            );

        if (!job) {
            return;
        }

        job.cancel();
        logger.info('scheduler.job_stopped', { jobId: templateId, reason });

        this.jobs.delete(
            templateId,
        );
        this.metadata.delete(templateId);
        logger.info(reason === 'reschedule' ? 'scheduler.job_replaced' : 'scheduler.job_removed', { jobId: templateId, reason });
    }

    cancelByPrefix(
        prefix: string,
    ): void {
        const matchingIds =
            [...this.jobs.keys()].filter(
                (jobId) =>
                    jobId.startsWith(
                        prefix,
                    ),
            );

        for (const jobId of matchingIds) {
            this.cancelTemplate(jobId, `prefix_cancel:${prefix}`);
        }
    }

    cancelAll(): void {
        for (const [jobId, job] of this.jobs) {
            job.cancel();
            logger.info('scheduler.job_stopped', { jobId, reason: 'cancel_all' });
            logger.info('scheduler.job_removed', { jobId, reason: 'cancel_all' });
        }

        this.jobs.clear();
        this.metadata.clear();
        logger.info('scheduler.all_jobs_cancelled');
    }

    hasJob(
        jobId: string,
    ): boolean {
        return this.jobs.has(
            jobId,
        );
    }

    getScheduledTemplateIds(): string[] {
        return [
            ...this.jobs.keys(),
        ];
    }

    getJobsSnapshot(): Array<{ jobId: string; clubId?: string; templateId?: string; slotId?: string; scheduledFor?: string; triggerSource?: string; nextRunAt?: string; libraryNextRunAt?: string; expectedNextRunAt?: string; timezone?: string; cronExpression?: string; localPublishAt?: string; isActive: boolean; running: number }> {
        return [...this.jobs].map(([jobId, job]) => ({
            jobId,
            nextRunAt: job.nextInvocation()?.toISOString(),
            libraryNextRunAt: job.nextInvocation()?.toISOString(),
            isActive: job.pendingInvocations.length > 0,
            running: this.runningCount(job),
            ...this.metadata.get(jobId),
        }));
    }

    private errorFields(error: unknown): { error: { name: string; message: string; stack?: string } } {
        if (error instanceof Error) return { error: { name: error.name, message: error.message, stack: error.stack } };
        return { error: { name: 'NonError', message: String(error) } };
    }

    private runningCount(job: Job): number {
        return Number((job as Job & { running?: number }).running ?? 0);
    }

    private formatLocal(value: { toISOString(): string }, timezone: string): string {
        // node-schedule returns a CronDate from nextInvocation(), not a native Date.
        const native = new Date(value.toISOString());
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(native);
        const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
        return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    }

    private createRule(
        template: SchedulerTemplate,
    ): RecurrenceRule {
        const [
            hours,
            minutes,
            seconds,
        ] = this.parseTime(
            template.publishTime,
        );

        const rule =
            new schedule.RecurrenceRule();

        rule.dayOfWeek =
            this.toNodeScheduleDay(
                template.dayOfWeek,
            );

        rule.hour = hours;
        rule.minute = minutes;
        rule.second = seconds;
        rule.tz = template.timezone;

        return rule;
    }

    private parseTime(
        time: string,
    ): [number, number, number] {
        const [
            hoursRaw,
            minutesRaw,
            secondsRaw = '0',
        ] = time.split(':');

        const hours =
            Number(hoursRaw);

        const minutes =
            Number(minutesRaw);
        const seconds = Number(secondsRaw);

        if (
            !Number.isInteger(hours) ||
            !Number.isInteger(minutes) ||
            !Number.isInteger(seconds) ||
            hours < 0 ||
            hours > 23 ||
            minutes < 0 ||
            minutes > 59 ||
            seconds < 0 ||
            seconds > 59
        ) {
            throw new Error(
                `Invalid time format: ${time}`,
            );
        }

        return [
            hours,
            minutes,
            seconds,
        ];
    }

    private toNodeScheduleDay(
        dayOfWeek: number,
    ): number {
        if (
            dayOfWeek < 1 ||
            dayOfWeek > 7
        ) {
            throw new Error(
                `Invalid dayOfWeek: ${dayOfWeek}`,
            );
        }

        return dayOfWeek === 7
            ? 0
            : dayOfWeek;
    }
}
