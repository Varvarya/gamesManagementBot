import { TrainingPublisherService } from '../trainings/training-publisher.service';
import { SchedulerService } from '../../scheduler/scheduler.service';
import { TemplateService } from './template.service';
import {
    TrainingTemplate,
    TrainingTemplateSlot,
} from './template.types';
import {
    resolveTemplateSlot,
} from './template.utils';

type CreateTemplateInput =
    Parameters<TemplateService['create']>[0];

type UpdateTemplateInput =
    Parameters<TemplateService['update']>[1];

export class TemplateSchedulerService {
    constructor(
        private readonly templates: TemplateService,
        private readonly scheduler: SchedulerService,
        private readonly publisher: TrainingPublisherService,
    ) {}

    async create(
        input: CreateTemplateInput,
    ): Promise<TrainingTemplate> {
        const template =
            await this.templates.create(input);

        this.syncTemplate(template);

        return template;
    }

    async update(
        templateId: string,
        input: UpdateTemplateInput,
    ): Promise<TrainingTemplate> {
        const template =
            await this.templates.update(
                templateId,
                input,
            );

        this.syncTemplate(template);

        return template;
    }

    async enable(
        templateId: string,
    ): Promise<TrainingTemplate> {
        const template =
            await this.templates.enable(
                templateId,
            );

        this.syncTemplate(template);

        return template;
    }

    async disable(
        templateId: string,
    ): Promise<TrainingTemplate> {
        const template =
            await this.templates.disable(
                templateId,
            );

        this.scheduler.cancelTemplate(
            template.id,
        );

        return template;
    }

    async delete(
        templateId: string,
    ): Promise<void> {
        this.scheduler.cancelTemplate(
            templateId,
        );

        await this.templates.delete(
            templateId,
        );
    }

    /**
     * Відновлення scheduler після запуску застосунку.
     *
     * Шаблони передає ApplicationContext,
     * тому TemplateService не потребує listEnabled().
     */
    restore(
        templates: TrainingTemplate[],
    ): void {
        for (const template of templates) {
            this.syncTemplate(template);
        }
    }

    syncTemplate(
        template: TrainingTemplate,
    ): void {
        this.scheduler.cancelTemplate(
            template.id,
        );

        if (!template.enabled) {
            return;
        }

        for (const slot of template.slots) {
            if (!slot.enabled) {
                continue;
            }

            this.scheduleSlot(
                template,
                slot,
            );
        }
    }

    private scheduleSlot(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
    ): void {
        const resolvedSlot =
            resolveTemplateSlot(
                template,
                slot,
            );

        const schedulerTemplate = {
            id: this.getSlotJobId(
                template.id,
                slot.id,
            ),

            dayOfWeek:
                this.calculatePublishDayOfWeek(
                    resolvedSlot.dayOfWeek,
                    resolvedSlot.publishDaysBefore,
                ),

            publishTime:
            resolvedSlot.publishTime,
        };

        this.scheduler.rescheduleTemplate(
            schedulerTemplate,
            async () => {
                const currentTemplate =
                    await this.templates.getRequired(
                        template.id,
                    );

                if (!currentTemplate.enabled) {
                    this.scheduler.cancelTemplate(
                        schedulerTemplate.id,
                    );

                    return;
                }

                const currentSlot =
                    currentTemplate.slots.find(
                        (item) =>
                            item.id === slot.id,
                    );

                if (
                    !currentSlot ||
                    !currentSlot.enabled
                ) {
                    this.scheduler.cancelTemplate(
                        schedulerTemplate.id,
                    );

                    return;
                }

                const currentResolvedSlot =
                    resolveTemplateSlot(
                        currentTemplate,
                        currentSlot,
                    );

                const trainingDate =
                    this.calculateTrainingDate(
                        currentResolvedSlot.dayOfWeek,
                    );

                await this.publisher.publishTemplateSlot({
                    templateId:
                    currentTemplate.id,

                    slotId:
                    currentSlot.id,

                    clubId:
                    currentTemplate.clubId,

                    chatId:
                    currentTemplate.chatId,

                    title:
                    currentTemplate.title,

                    location:
                    currentTemplate.location,

                    date:
                    trainingDate,

                    startTime:
                    currentResolvedSlot.startTime,

                    endTime:
                    currentResolvedSlot.endTime,

                    placesLimit:
                    currentResolvedSlot.placesLimit,

                    minPlayers:
                    currentResolvedSlot.minPlayers,
                });
            },
        );
    }

    private calculatePublishDayOfWeek(
        trainingDayOfWeek: number,
        publishDaysBefore: number,
    ): number {
        const result =
            (
                trainingDayOfWeek -
                publishDaysBefore -
                1 +
                7
            ) % 7;

        return result + 1;
    }

    private calculateTrainingDate(
        targetDayOfWeek: number,
    ): string {
        const current = new Date();

        const currentDay =
            current.getDay() === 0
                ? 7
                : current.getDay();

        let daysToAdd =
            targetDayOfWeek -
            currentDay;

        if (daysToAdd < 0) {
            daysToAdd += 7;
        }

        current.setDate(
            current.getDate() +
            daysToAdd,
        );

        return this.formatDate(current);
    }

    private formatDate(
        value: Date,
    ): string {
        const year =
            value.getFullYear();

        const month =
            String(
                value.getMonth() + 1,
            ).padStart(2, '0');

        const day =
            String(
                value.getDate(),
            ).padStart(2, '0');

        return `${year}-${month}-${day}`;
    }

    private getSlotJobId(
        templateId: string,
        slotId: string,
    ): string {
        return `template:${templateId}:slot:${slotId}`;
    }
}