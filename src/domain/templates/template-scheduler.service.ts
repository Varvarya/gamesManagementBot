import { TrainingPublisherService } from '../trainings/training-publisher.service';
import { SchedulerService } from '../../scheduler/scheduler.service';
import { TemplateService } from './template.service';
import { TrainingTemplate } from './template.types';

type CreateTemplateInput = Parameters<TemplateService['create']>[0];

type UpdateTemplateInput = Parameters<TemplateService['update']>[1];

export class TemplateSchedulerService {
    constructor(
        private readonly templates: TemplateService,
        private readonly scheduler: SchedulerService,
        private readonly publisher: TrainingPublisherService,
    ) {}

    async create(
        input: CreateTemplateInput,
    ): Promise<TrainingTemplate> {
        const template = await this.templates.create(input);

        this.syncTemplate(template);

        return template;
    }

    async update(
        templateId: string,
        input: UpdateTemplateInput,
    ): Promise<TrainingTemplate> {
        const template = await this.templates.update(
            templateId,
            input,
        );

        this.syncTemplate(template);

        return template;
    }

    async enable(
        templateId: string,
    ): Promise<TrainingTemplate> {
        const template = await this.templates.enable(templateId);

        this.syncTemplate(template);

        return template;
    }

    async disable(
        templateId: string,
    ): Promise<TrainingTemplate> {
        const template = await this.templates.disable(templateId);

        this.scheduler.cancelTemplate(template.id);

        return template;
    }

    async delete(templateId: string): Promise<void> {
        this.scheduler.cancelTemplate(templateId);

        await this.templates.delete(templateId);
    }

    syncTemplate(template: TrainingTemplate): void {
        if (!template.enabled) {
            this.scheduler.cancelTemplate(template.id);
            return;
        }

        this.scheduler.rescheduleTemplate(
            template,
            async (scheduledTemplate) => {
                const trainingDate = this.calculateTrainingDate(
                    scheduledTemplate.dayOfWeek,
                );

                await this.publisher.publishFromTemplate(
                    scheduledTemplate,
                    trainingDate,
                );
            },
        );
    }

    private calculateTrainingDate(
        targetDayOfWeek: number,
    ): string {
        const current = new Date();

        const currentDay =
            current.getDay() === 0
                ? 7
                : current.getDay();

        let daysToAdd = targetDayOfWeek - currentDay;

        if (daysToAdd < 0) {
            daysToAdd += 7;
        }

        current.setDate(
            current.getDate() + daysToAdd,
        );

        const year = current.getFullYear();
        const month = String(
            current.getMonth() + 1,
        ).padStart(2, '0');
        const day = String(
            current.getDate(),
        ).padStart(2, '0');

        return `${year}-${month}-${day}`;
    }
}