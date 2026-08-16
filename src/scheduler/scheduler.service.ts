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
};
export type SchedulerOneOff = { id: string; date: string; time: string; timezone: string };

type SchedulerPublishHandler =
    () => Promise<void>;

export class SchedulerService {
    private readonly jobs =
        new Map<string, Job>();

    rescheduleTemplate(
        template: SchedulerTemplate,
        onPublish: SchedulerPublishHandler,
    ): void {
        this.cancelTemplate(
            template.id,
        );

        const rule =
            this.createRule(
                template,
            );

        const job =
            schedule.scheduleJob(
                rule,
                async () => {
                    logger.info('scheduler.job_started', { jobId: template.id });
                    try {
                        await onPublish();
                        logger.info('scheduler.job_completed', { jobId: template.id });
                    } catch (error) {
                        logger.error('scheduler.job_failed', { jobId: template.id, stage: 'execute', error });
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
        logger.info('scheduler.job_scheduled', { jobId: template.id, dayOfWeek: template.dayOfWeek, publishTime: template.publishTime, timezone: template.timezone, computedNextPublishAt: job.nextInvocation()?.toISOString(), jobRegistered: true });
    }

    rescheduleOneOff(input: SchedulerOneOff, onPublish: SchedulerPublishHandler): void {
        this.cancelTemplate(input.id);
        const [year, month, day] = input.date.split('-').map(Number);
        const [hour, minute] = this.parseTime(input.time);
        const rule = new schedule.RecurrenceRule();
        rule.year = year; rule.month = month - 1; rule.date = day; rule.hour = hour; rule.minute = minute; rule.second = 0; rule.tz = input.timezone;
        const job = schedule.scheduleJob(rule, async () => {
            logger.info('scheduler.job_started', { jobId: input.id });
            try {
                await onPublish();
                logger.info('scheduler.job_completed', { jobId: input.id });
            } catch (error) {
                logger.error('scheduler.job_failed', { jobId: input.id, stage: 'execute', error });
            } finally {
                this.jobs.delete(input.id);
            }
        });
        if (!job) {
            logger.info('scheduler.one_off_not_registered', { jobId: input.id, date: input.date, time: input.time, timezone: input.timezone, jobRegistered: false, reason: 'past_due' });
            return; // Past one-off jobs are reconciled explicitly and never replayed on restore.
        }
        this.jobs.set(input.id, job);
        logger.info('scheduler.one_off_scheduled', { jobId: input.id, date: input.date, time: input.time, timezone: input.timezone, computedNextPublishAt: job.nextInvocation()?.toISOString(), jobRegistered: true });
    }

    cancelTemplate(
        templateId: string,
    ): void {
        const job =
            this.jobs.get(
                templateId,
            );

        if (!job) {
            return;
        }

        job.cancel();

        this.jobs.delete(
            templateId,
        );
        logger.info('scheduler.job_cancelled', { jobId: templateId });
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
            this.cancelTemplate(
                jobId,
            );
        }
    }

    cancelAll(): void {
        for (const job of this.jobs.values()) {
            job.cancel();
        }

        this.jobs.clear();
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

    getJobsSnapshot(): Array<{ jobId: string; nextRunAt?: string }> {
        return [...this.jobs].map(([jobId, job]) => ({
            jobId,
            nextRunAt: job.nextInvocation()?.toISOString(),
        }));
    }

    private createRule(
        template: SchedulerTemplate,
    ): RecurrenceRule {
        const [
            hours,
            minutes,
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
        rule.second = 0;
        rule.tz = template.timezone;

        return rule;
    }

    private parseTime(
        time: string,
    ): [number, number] {
        const [
            hoursRaw,
            minutesRaw,
        ] = time.split(':');

        const hours =
            Number(hoursRaw);

        const minutes =
            Number(minutesRaw);

        if (
            !Number.isInteger(hours) ||
            !Number.isInteger(minutes) ||
            hours < 0 ||
            hours > 23 ||
            minutes < 0 ||
            minutes > 59
        ) {
            throw new Error(
                `Invalid time format: ${time}`,
            );
        }

        return [
            hours,
            minutes,
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
