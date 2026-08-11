import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingService } from '../trainings/training.service';
import { ScheduleException } from './schedule-exception.types';
import { ScheduleOccurrenceResolver } from './schedule-occurrence.resolver';

export class ScheduleExceptionReconciliationService {
    constructor(private readonly repositories: RepositoriesContext, private readonly trainings: TrainingService, private readonly resolver: ScheduleOccurrenceResolver) {}

    async apply(exception: ScheduleException): Promise<{ trainingId?: string; action: 'none' | 'cancelled' | 'updated' }> {
        if (exception.type === 'extra' || !exception.scheduleEntryId) return { action: 'none' };
        const training = await this.repositories.trainings.findAnyByTemplateSlotAndDate(exception.scheduleEntryId, exception.date);
        if (!training) return { action: 'none' };
        if (exception.type === 'cancel') {
            if (training.status === 'draft' || training.status === 'open' || training.status === 'closed') await this.trainings.cancel(training.id);
            return { trainingId: training.id, action: 'cancelled' };
        }
        const templates = await this.repositories.templates.list();
        const template = templates.find((item) => item.slots.some((slot) => slot.id === exception.scheduleEntryId));
        const slot = template?.slots.find((item) => item.id === exception.scheduleEntryId);
        if (!template || !slot) return { action: 'none' };
        const occurrence = this.resolver.resolveRecurring(template, slot, exception.date, exception);
        if (!occurrence) return { action: 'none' };
        training.title = occurrence.title; training.location = occurrence.location; training.date = occurrence.date;
        training.startTime = occurrence.startTime; training.endTime = occurrence.endTime;
        training.placesLimit = occurrence.placesLimit; training.minPlayers = occurrence.minPlayers;
        training.cancelCheckHoursBefore = occurrence.cancelCheckHoursBefore;
        // A Telegram message cannot be atomically moved between chats. Existing publication remains in its original chat.
        if (!training.messageId) training.chatId = occurrence.chatId;
        await this.trainings.save(training);
        return { trainingId: training.id, action: 'updated' };
    }

    async revert(exception: ScheduleException): Promise<{ trainingId?: string; action: 'none' | 'updated' }> {
        if (exception.type === 'extra' || !exception.scheduleEntryId) return { action: 'none' };
        const training = await this.repositories.trainings.findAnyByTemplateSlotAndDate(exception.scheduleEntryId, exception.date);
        if (!training) return { action: 'none' };
        const templates = await this.repositories.templates.list();
        const template = templates.find((item) => item.slots.some((slot) => slot.id === exception.scheduleEntryId));
        const slot = template?.slots.find((item) => item.id === exception.scheduleEntryId);
        if (!template || !slot || !template.enabled || !slot.enabled) return { action: 'none' };
        const occurrence = this.resolver.resolveRecurring(template, slot, exception.date);
        if (!occurrence) return { action: 'none' };
        training.title = occurrence.title; training.location = occurrence.location; training.date = occurrence.date;
        training.startTime = occurrence.startTime; training.endTime = occurrence.endTime;
        training.placesLimit = occurrence.placesLimit; training.minPlayers = occurrence.minPlayers;
        training.cancelCheckHoursBefore = occurrence.cancelCheckHoursBefore;
        if (!training.messageId) training.chatId = occurrence.chatId;
        if (training.status === 'cancelled') training.status = 'open';
        await this.trainings.save(training);
        return { trainingId: training.id, action: 'updated' };
    }
}
