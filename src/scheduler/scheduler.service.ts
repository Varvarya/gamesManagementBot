import schedule, { Job, RecurrenceRule } from 'node-schedule';
import { TrainingService } from '../domain/trainings/training.service';
import { TrainingTemplate } from '../domain/templates/template.types';

type SchedulerPublishHandler = (template: TrainingTemplate) => Promise<void>;

export class SchedulerService {
    private readonly jobs = new Map<string, Job>();

    constructor(
        private readonly trainings: TrainingService,
    ) {}

    restoreTemplates(
        templates: TrainingTemplate[],
        onPublish: SchedulerPublishHandler,
    ): void {
        this.cancelAll();

        for (const template of templates) {
            if (template.enabled) {
                this.scheduleTemplate(template, onPublish);
            }
        }
    }

    scheduleTemplate(
        template: TrainingTemplate,
        onPublish: SchedulerPublishHandler,
    ): void {
        this.cancelTemplate(template.id);

        if (!template.enabled) {
            return;
        }

        const rule = this.createRule(template);

        const job = schedule.scheduleJob(rule, async () => {
            try {
                await onPublish(template);
            } catch (error) {
                console.error(
                    `Failed to publish training from template ${template.id}`,
                    error,
                );
            }
        });

        if (!job) {
            throw new Error(`Failed to schedule template ${template.id}`);
        }

        this.jobs.set(template.id, job);
    }

    rescheduleTemplate(
        template: TrainingTemplate,
        onPublish: SchedulerPublishHandler,
    ): void {
        this.scheduleTemplate(template, onPublish);
    }

    cancelTemplate(templateId: string): void {
        const job = this.jobs.get(templateId);

        if (!job) {
            return;
        }

        job.cancel();
        this.jobs.delete(templateId);
    }

    cancelAll(): void {
        for (const job of this.jobs.values()) {
            job.cancel();
        }

        this.jobs.clear();
    }

    getScheduledTemplateIds(): string[] {
        return [...this.jobs.keys()];
    }

    private createRule(template: TrainingTemplate): RecurrenceRule {
        const [hours, minutes] = this.parseTime(template.publishTime);

        const rule = new schedule.RecurrenceRule();

        /**
         * node-schedule uses:
         * 0 = Sunday
         * 1 = Monday
         * ...
         * 6 = Saturday
         *
         * Our template uses:
         * 1 = Monday
         * ...
         * 7 = Sunday
         */
        rule.dayOfWeek = this.toNodeScheduleDay(template.publishDayOfWeek);
        rule.hour = hours;
        rule.minute = minutes;
        rule.second = 0;

        return rule;
    }

    private parseTime(time: string): [number, number] {
        const [hoursRaw, minutesRaw] = time.split(':');

        const hours = Number(hoursRaw);
        const minutes = Number(minutesRaw);

        if (
            !Number.isInteger(hours) ||
            !Number.isInteger(minutes) ||
            hours < 0 ||
            hours > 23 ||
            minutes < 0 ||
            minutes > 59
        ) {
            throw new Error(`Invalid time format: ${time}`);
        }

        return [hours, minutes];
    }

    private toNodeScheduleDay(dayOfWeek: number): number {
        if (dayOfWeek < 1 || dayOfWeek > 7) {
            throw new Error(`Invalid dayOfWeek: ${dayOfWeek}`);
        }

        return dayOfWeek === 7 ? 0 : dayOfWeek;
    }
}