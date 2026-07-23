import schedule, {
    Job,
    RecurrenceRule,
} from 'node-schedule';

export type SchedulerTemplate = {
    id: string;
    dayOfWeek: number;
    publishTime: string;
};

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
                    try {
                        await onPublish();
                    } catch (error) {
                        console.error(
                            `Scheduled job failed: ${template.id}`,
                            error,
                        );
                    }
                },
            );

        if (!job) {
            throw new Error(
                `Failed to schedule job: ${template.id}`,
            );
        }

        this.jobs.set(
            template.id,
            job,
        );
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