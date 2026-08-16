import { Markup } from 'telegraf';
import { callbackButton } from '../../callback-data';
import { UpcomingTrainingView } from '../../../domain/trainings/upcoming-trainings-query.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createUpcomingTrainingsKeyboard(items: Array<{ token: string; item: UpcomingTrainingView }>, expanded: boolean) {
    return Markup.inlineKeyboard([
        ...items.map(({ token, item }) => [callbackButton(itemButton(item), item.training
            ? `${AdminCallbacks.TrainingPrefix}${item.training.id}`
            : `${AdminCallbacks.ScheduleUpcomingOpenPrefix}${token}`, item.training ? AdminCallbacks.TrainingPrefix : AdminCallbacks.ScheduleUpcomingOpenPrefix, 'upcoming-item')]),
        ...(!expanded ? [[Markup.button.callback('📅 Показати більше', AdminCallbacks.ScheduleUpcomingMore)]] : []),
        [Markup.button.callback('◀️ До розкладу', AdminCallbacks.Schedule)],
    ]);
}

export function createUpcomingOccurrenceKeyboard(token: string, item: UpcomingTrainingView) {
    return Markup.inlineKeyboard([
        ...(['FUTURE_OCCURRENCE', 'MISSED_PUBLICATION'].includes(item.type) ? [[Markup.button.callback('🚀 Опублікувати зараз', `${AdminCallbacks.ScheduleUpcomingPublishPrefix}${token}`)]] : []),
        ...(item.type === 'FUTURE_OCCURRENCE' && item.scheduleEntryId ? [[Markup.button.callback('✏️ Виняток на цю дату', `${AdminCallbacks.ScheduleUpcomingExceptionPrefix}${token}`)]] : []),
        [Markup.button.callback('📅 До розкладу', AdminCallbacks.Schedule)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.ScheduleUpcoming)],
    ]);
}

function itemButton(item: UpcomingTrainingView): string {
    const icon = item.type === 'CREATED_TRAINING' ? '🏸' : item.type === 'MISSED_PUBLICATION' ? '⚠️' : item.type === 'PAUSED_SCHEDULE' ? '⏸' : item.type === 'CANCELLED' ? '🔴' : '🕓';
    const shortTitle = item.title.length > 28 ? `${item.title.slice(0, 27)}…` : item.title;
    return `${icon} ${item.date.slice(5).split('-').reverse().join('.')} · ${item.startTime} · ${shortTitle}`;
}
