import { TrainingTemplate, TrainingTemplateSlot } from '../templates/template.types';
import { resolveTemplateSlot } from '../templates/template.utils';
import { EffectiveOccurrence, ScheduleException } from './schedule-exception.types';

export class ScheduleOccurrenceResolver {
    resolveRecurring(template: TrainingTemplate, slot: TrainingTemplateSlot, date: string, exception?: ScheduleException): EffectiveOccurrence | undefined {
        if (!template.enabled || !slot.enabled || exception?.type === 'cancel') return undefined;
        const base = resolveTemplateSlot(template, slot);
        const override = exception?.type === 'override' ? exception : undefined;
        return {
            exceptionId: override?.id, clubId: template.clubId, scheduleId: template.id, scheduleEntryId: slot.id, date,
            type: override ? 'override' : 'recurring', title: override?.title ?? template.title, location: template.location,
            startTime: override?.startTime ?? base.startTime, endTime: override?.endTime ?? base.endTime,
            placesLimit: override?.placesLimit ?? base.placesLimit, minPlayers: override?.minPlayers ?? base.minPlayers,
            publishDaysBefore: override?.publishDaysBefore ?? base.publishDaysBefore,
            publishTime: override?.publishTime ?? base.publishTime,
            publicationEnabled: override?.publicationEnabled ?? true,
            chatId: override?.chatIds?.[0] ?? template.chatId,
            cancelCheckHoursBefore: template.cancelCheckHoursBefore ?? 4,
        };
    }

    resolveExtra(exception: ScheduleException): EffectiveOccurrence | undefined {
        if (exception.type !== 'extra' || exception.publicationEnabled === false || !exception.title || !exception.startTime || !exception.endTime
            || !exception.placesLimit || exception.minPlayers === undefined || !exception.publishTime || !exception.chatIds?.[0]) return undefined;
        return { exceptionId: exception.id, clubId: exception.clubId, date: exception.date, type: 'extra', title: exception.title,
            startTime: exception.startTime, endTime: exception.endTime, placesLimit: exception.placesLimit, minPlayers: exception.minPlayers,
            publishDaysBefore: exception.publishDaysBefore ?? 0, publishTime: exception.publishTime, publicationEnabled: true,
            chatId: exception.chatIds[0], cancelCheckHoursBefore: 4 };
    }
}
