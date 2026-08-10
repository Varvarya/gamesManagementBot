import { SchedulerService } from '../../scheduler/scheduler.service';
import { SettingsRepository } from '../../storage/repositories/settings.repository';
import { ChatService } from '../chats/chat.service';
import { TrainingPublisherService } from '../trainings/training-publisher.service';
import { TemplateService } from './template.service';
import {
    TrainingTemplate,
    TrainingTemplateSlot,
} from './template.types';
import { resolveTemplateSlot } from './template.utils';
import { logger } from '../../utils/logger';

type CreateTemplateInput =
    Parameters<TemplateService['create']>[0];
type UpdateTemplateInput =
    Parameters<TemplateService['update']>[1];

type ZonedNow = {
    date: string;
    time: string;
};

export class TemplateSchedulerService {
    constructor(
        private readonly templates: TemplateService,
        private readonly scheduler: SchedulerService,
        private readonly publisher: TrainingPublisherService,
        private readonly chats: ChatService,
        private readonly settings: SettingsRepository,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async create(input: CreateTemplateInput): Promise<TrainingTemplate> {
        const template = await this.templates.create(input);
        await this.syncTemplate(template);
        return template;
    }

    async update(templateId: string, input: UpdateTemplateInput): Promise<TrainingTemplate> {
        const template = await this.templates.update(templateId, input);
        await this.syncTemplate(template);
        return template;
    }

    async enable(templateId: string): Promise<TrainingTemplate> {
        const template = await this.templates.enable(templateId);
        await this.syncTemplate(template);
        return template;
    }

    async disable(templateId: string): Promise<TrainingTemplate> {
        const template = await this.templates.disable(templateId);
        this.cancelTemplateJobs(template.clubId, template.id);
        return template;
    }

    async delete(templateId: string): Promise<void> {
        const template = await this.templates.getRequired(templateId);
        this.cancelTemplateJobs(template.clubId, templateId);
        await this.templates.delete(templateId);
    }

    async restore(templates: TrainingTemplate[]): Promise<number> {
        this.scheduler.cancelAll();

        for (const template of templates) {
            // Restoring recurring jobs is non-destructive. Missed publications
            // need an explicit reconciliation decision and are not replayed here.
            await this.syncTemplate(template, false);
        }

        return this.scheduler.getScheduledTemplateIds()
            .filter(id => id.startsWith('club:'))
            .length;
    }

    async syncTemplate(
        template: TrainingTemplate,
        publishMissed = false,
    ): Promise<void> {
        this.cancelTemplateJobs(template.clubId, template.id);

        if (!template.enabled) return;
        if (!template.slots.length) {
            throw new Error(`Template ${template.id} has no slots`);
        }

        const { timezone } = await this.settings.get();

        for (const slot of template.slots) {
            if (!slot.enabled) continue;
            this.scheduleSlot(template, slot, timezone);

            if (publishMissed) {
                try {
                    await this.publishMissedIfRelevant(
                        template,
                        slot,
                        timezone,
                    );
                } catch (error) {
                    logger.error('scheduler.missed_publication_failed', { jobId: this.getSlotJobId(template.clubId, template.id, slot.id), clubId: template.clubId, templateId: template.id, slotId: slot.id, error });
                }
            }
        }
    }

    private scheduleSlot(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
        timezone: string,
    ): void {
        const resolved = resolveTemplateSlot(template, slot);
        const jobId = this.getSlotJobId(template.clubId, template.id, slot.id);

        this.scheduler.rescheduleTemplate(
            {
                id: jobId,
                dayOfWeek: calculatePublishDayOfWeek(
                    resolved.dayOfWeek,
                    resolved.publishDaysBefore,
                ),
                publishTime: resolved.publishTime,
                timezone,
            },
            async () => {
                try {
                    const currentTemplate =
                        await this.templates.getRequired(template.id);
                    const currentSlot = currentTemplate.slots.find(
                        item => item.id === slot.id,
                    );

                    if (!currentTemplate.enabled || !currentSlot?.enabled) {
                        this.scheduler.cancelTemplate(jobId);
                        return;
                    }

                    const currentResolved =
                        resolveTemplateSlot(currentTemplate, currentSlot);
                    const publicationDate = getZonedNow(this.now(), timezone).date;
                    const trainingDate = addCalendarDays(
                        publicationDate,
                        currentResolved.publishDaysBefore,
                    );

                    await this.publishSlot(currentTemplate, currentSlot, trainingDate);
                } catch (error) {
                    logger.error('scheduler.automatic_publication_failed', { jobId, templateId: template.id, slotId: slot.id, error });
                }
            },
        );
    }

    private async publishMissedIfRelevant(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
        timezone: string,
    ): Promise<void> {
        const resolved = resolveTemplateSlot(template, slot);
        const zonedNow = getZonedNow(this.now(), timezone);
        const trainingDate = findNearestFutureTrainingDate(
            zonedNow,
            resolved.dayOfWeek,
            resolved.startTime,
        );
        const publicationDate = addCalendarDays(
            trainingDate,
            -resolved.publishDaysBefore,
        );

        if (
            publicationDate < zonedNow.date ||
            (
                publicationDate === zonedNow.date &&
                resolved.publishTime <= zonedNow.time
            )
        ) {
            await this.publishSlot(template, slot, trainingDate);
        }
    }

    private async publishSlot(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
        trainingDate: string,
    ): Promise<void> {
        const chat = await this.chats.getById(template.chatId);
        if (!chat?.enabled) {
            throw new Error(
                `Template ${template.id} chat ${template.chatId} is missing or disabled`,
            );
        }

        const resolved = resolveTemplateSlot(template, slot);
        await this.publisher.publishTemplateSlot({
            templateId: template.id,
            slotId: slot.id,
            clubId: template.clubId,
            chatId: template.chatId,
            title: template.title,
            location: template.location,
            date: trainingDate,
            startTime: resolved.startTime,
            endTime: resolved.endTime,
            placesLimit: resolved.placesLimit,
            minPlayers: resolved.minPlayers,
            cancelCheckHoursBefore: template.cancelCheckHoursBefore ?? 4,
        });
    }

    private cancelTemplateJobs(clubId: string, templateId: string): void {
        this.scheduler.cancelByPrefix(`club:${clubId}:template:${templateId}:slot:`);
    }

    private getSlotJobId(clubId: string, templateId: string, slotId: string): string {
        return `club:${clubId}:template:${templateId}:slot:${slotId}`;
    }
}

export function calculatePublishDayOfWeek(
    trainingDayOfWeek: number,
    publishDaysBefore: number,
): number {
    return ((trainingDayOfWeek - publishDaysBefore - 1) % 7 + 7) % 7 + 1;
}

export function addCalendarDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

export function findNearestFutureTrainingDate(
    now: ZonedNow,
    dayOfWeek: number,
    startTime: string,
): string {
    for (let offset = 0; offset <= 7; offset += 1) {
        const date = addCalendarDays(now.date, offset);
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
        if (
            weekday === dayOfWeek &&
            (offset > 0 || startTime > now.time)
        ) {
            return date;
        }
    }
    return addCalendarDays(now.date, 7);
}

export function getZonedNow(value: Date, timezone: string): ZonedNow {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find(part => part.type === type)?.value ?? '';
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${get('hour')}:${get('minute')}`,
    };
}
