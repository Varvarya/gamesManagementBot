import { RepositoriesContext } from '../../app/repositories.context';
import { addCalendarDays, getZonedNow } from '../templates/template-scheduler.service';
import { resolveTemplateSlot } from '../templates/template.utils';
import { ScheduleOccurrenceResolver } from '../schedule-exceptions/schedule-occurrence.resolver';
import { EffectiveOccurrence } from '../schedule-exceptions/schedule-exception.types';
import { Training } from './training.types';
import { TrainingTemplateSlot } from '../templates/template.types';

export type UpcomingTrainingViewType =
    | 'CREATED_TRAINING'
    | 'FUTURE_OCCURRENCE'
    | 'MISSED_PUBLICATION'
    | 'PAUSED_SCHEDULE'
    | 'CANCELLED';

export type UpcomingTrainingView = {
    key: string;
    type: UpcomingTrainingViewType;
    clubId: string;
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    placesLimit: number;
    registeredPlaces?: number;
    publicationDate?: string;
    publicationTime?: string;
    chatId?: number;
    chatTitle?: string;
    training?: Training;
    occurrence?: EffectiveOccurrence;
    scheduleId?: string;
    scheduleEntryId?: string;
    exceptionId?: string;
};

export class UpcomingTrainingsQueryService {
    constructor(
        private readonly repositories: RepositoriesContext,
        private readonly occurrenceResolver: ScheduleOccurrenceResolver,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async list(days = 7): Promise<UpcomingTrainingView[]> {
        const [settings, templates, trainings, exceptions, chats] = await Promise.all([
            this.repositories.settings.get(),
            this.repositories.templates.list(),
            this.repositories.trainings.list(),
            this.repositories.scheduleExceptions.list(),
            this.repositories.chats.getAll(),
        ]);
        const zonedNow = getZonedNow(this.now(), settings.timezone);
        const endDate = addCalendarDays(zonedNow.date, Math.max(1, days) - 1);
        const relevantTrainings = trainings.filter((training) => training.date >= zonedNow.date && training.date <= endDate && !['finished', 'archived'].includes(training.status));
        const trainingByOccurrence = new Map(relevantTrainings.filter((training) => training.templateId && training.templateSlotId)
            .map((training) => [occurrenceKey(training.templateId!, training.templateSlotId!, training.date), training]));
        const consumedTrainingIds = new Set<string>();
        const chatNames = new Map(chats.map((chat) => [chat.id, chat.name]));
        const exceptionByOccurrence = new Map(exceptions.filter((item) => item.scheduleEntryId)
            .map((item) => [`${item.scheduleEntryId}:${item.date}`, item]));
        const result: UpcomingTrainingView[] = [];

        for (const template of templates) {
            if (!template.enabled) {
                const nearest = nearestTemplateSlot(template.slots, zonedNow.date, endDate);
                if (nearest) {
                    const resolved = resolveTemplateSlot(template, nearest.slot);
                    const existing = trainingByOccurrence.get(occurrenceKey(template.id, nearest.slot.id, nearest.date));
                    if (existing) { consumedTrainingIds.add(existing.id); result.push(createdView(existing, chatNames.get(existing.chatId))); }
                    else result.push({ key: `paused:${template.id}`, type: 'PAUSED_SCHEDULE', clubId: template.clubId, title: template.title,
                        date: nearest.date, startTime: resolved.startTime, endTime: resolved.endTime, placesLimit: resolved.placesLimit,
                        scheduleId: template.id, scheduleEntryId: nearest.slot.id });
                }
                continue;
            }
            for (let date = zonedNow.date; date <= endDate; date = addCalendarDays(date, 1)) {
                const weekday = weekdayOf(date);
                for (const slot of template.slots.filter((item) => item.enabled && item.dayOfWeek === weekday)) {
                    const exception = exceptionByOccurrence.get(`${slot.id}:${date}`);
                    const publicationIdentity = occurrenceKey(template.id, slot.id, date);
                    const existing = trainingByOccurrence.get(publicationIdentity);
                    if (existing) {
                        consumedTrainingIds.add(existing.id);
                        result.push(createdView(existing, chatNames.get(existing.chatId)));
                        continue;
                    }
                    if (exception?.type === 'cancel') {
                        const base = resolveTemplateSlot(template, slot);
                        result.push({ key: `cancel:${slot.id}:${date}`, type: 'CANCELLED', clubId: template.clubId, title: template.title,
                            date, startTime: base.startTime, endTime: base.endTime, placesLimit: base.placesLimit,
                            scheduleId: template.id, scheduleEntryId: slot.id, exceptionId: exception.id });
                        continue;
                    }
                    const occurrence = this.occurrenceResolver.resolveRecurring(template, slot, date, exception);
                    if (occurrence) result.push(occurrenceView(occurrence, zonedNow, chatNames.get(occurrence.chatId)));
                }
            }
        }

        for (const exception of exceptions.filter((item) => item.type === 'extra' && item.date >= zonedNow.date && item.date <= endDate)) {
            const occurrence = this.occurrenceResolver.resolveExtra(exception);
            if (!occurrence) continue;
            const existing = trainingByOccurrence.get(occurrenceKey(`exception:${exception.id}`, 'extra', exception.date));
            if (existing) { consumedTrainingIds.add(existing.id); result.push(createdView(existing, chatNames.get(existing.chatId))); }
            else result.push(occurrenceView(occurrence, zonedNow, chatNames.get(occurrence.chatId)));
        }

        for (const training of relevantTrainings) {
            if (!consumedTrainingIds.has(training.id)) result.push(createdView(training, chatNames.get(training.chatId)));
        }
        return result.sort((a, b) => `${a.date}T${a.startTime}:${a.title}`.localeCompare(`${b.date}T${b.startTime}:${b.title}`));
    }
}

function occurrenceView(occurrence: EffectiveOccurrence, now: { date: string; time: string }, chatTitle?: string): UpcomingTrainingView {
    const publicationDate = addCalendarDays(occurrence.date, -occurrence.publishDaysBefore);
    const publicationPassed = publicationDate < now.date || (publicationDate === now.date && occurrence.publishTime <= now.time);
    const trainingFuture = occurrence.date > now.date || (occurrence.date === now.date && occurrence.startTime > now.time);
    return {
        key: `occurrence:${occurrence.scheduleId ?? occurrence.exceptionId}:${occurrence.scheduleEntryId ?? 'extra'}:${occurrence.date}`,
        type: occurrence.publicationEnabled && publicationPassed && trainingFuture ? 'MISSED_PUBLICATION' : 'FUTURE_OCCURRENCE',
        clubId: occurrence.clubId, title: occurrence.title, date: occurrence.date, startTime: occurrence.startTime,
        endTime: occurrence.endTime, placesLimit: occurrence.placesLimit, publicationDate, publicationTime: occurrence.publishTime,
        chatId: occurrence.chatId, chatTitle, occurrence, scheduleId: occurrence.scheduleId,
        scheduleEntryId: occurrence.scheduleEntryId, exceptionId: occurrence.exceptionId,
    };
}

function createdView(training: Training, chatTitle?: string): UpcomingTrainingView {
    return { key: `training:${training.id}`, type: training.status === 'cancelled' ? 'CANCELLED' : 'CREATED_TRAINING', clubId: training.clubId,
        title: training.title, date: training.date, startTime: training.startTime, endTime: training.endTime, placesLimit: training.placesLimit,
        registeredPlaces: training.participants.reduce((sum, entry) => sum + entry.places, 0), chatId: training.chatId, chatTitle,
        training, scheduleId: training.templateId, scheduleEntryId: training.templateSlotId };
}

function nearestTemplateSlot(slots: TrainingTemplateSlot[], from: string, to: string) {
    for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
        const slot = slots.filter((item) => item.enabled && item.dayOfWeek === weekdayOf(date)).sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
        if (slot) return { slot, date };
    }
    return undefined;
}

function weekdayOf(date: string): number { return new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7; }
function occurrenceKey(templateId: string, slotId: string, date: string): string { return `${templateId}:${slotId}:${date}`; }
