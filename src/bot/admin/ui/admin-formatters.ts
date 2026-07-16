import { Player } from '../../../domain/players/player.types';
import { TrainingTemplate } from '../../../domain/templates/template.types';
import { Training } from '../../../domain/trainings/training.types';

const DAY_NAMES: Record<number, string> = {
    1: 'Понеділок',
    2: 'Вівторок',
    3: 'Середа',
    4: 'Четвер',
    5: 'Пʼятниця',
    6: 'Субота',
    7: 'Неділя',
};

const SHORT_DAY_NAMES: Record<number, string> = {
    1: 'Пн',
    2: 'Вт',
    3: 'Ср',
    4: 'Чт',
    5: 'Пт',
    6: 'Сб',
    7: 'Нд',
};

export function formatDay(
    dayOfWeek: number,
): string {
    return DAY_NAMES[dayOfWeek] ?? String(dayOfWeek);
}

export function formatShortDay(
    dayOfWeek: number,
): string {
    return SHORT_DAY_NAMES[dayOfWeek] ?? String(dayOfWeek);
}

export function formatDate(
    value: string,
): string {
    const date = new Date(`${value}T12:00:00`);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return new Intl.DateTimeFormat('uk-UA', {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
    }).format(date);
}

export function formatTimeRange(
    startTime: string,
    endTime: string,
): string {
    return `${startTime}–${endTime}`;
}

export function countTrainingPlaces(
    training: Training,
): number {
    return training.participants.reduce(
        (sum, participant) =>
            sum + participant.places,
        0,
    );
}

export function countWaitlistPlaces(
    training: Training,
): number {
    return training.waitlist.reduce(
        (sum, participant) =>
            sum + participant.places,
        0,
    );
}

export function getTrainingStatus(
    training: Training,
): {
    icon: string;
    title: string;
} {
    switch (training.status) {
        case 'open':
            return {
                icon: '🟢',
                title: 'Запис відкрито',
            };

        case 'closed':
            return {
                icon: '🔒',
                title: 'Запис закрито',
            };

        case 'cancelled':
            return {
                icon: '❌',
                title: 'Скасовано',
            };

        case 'finished':
            return {
                icon: '✅',
                title: 'Завершено',
            };

        case 'draft':
            return {
                icon: '⚪️',
                title: 'Чернетка',
            };
    }
}

export function renderTrainingCard(
    training: Training,
): string {
    const status = getTrainingStatus(training);
    const registered = countTrainingPlaces(training);
    const waiting = countWaitlistPlaces(training);
    const free = Math.max(
        training.placesLimit - registered,
        0,
    );

    return [
        `${status.icon} ${training.title}`,
        '',
        `📅 ${formatDate(training.date)}`,
        `🕐 ${formatTimeRange(
            training.startTime,
            training.endTime,
        )}`,
        training.location
            ? `📍 ${training.location}`
            : undefined,
        '',
        `👥 Записано: ${registered}/${training.placesLimit}`,
        `🪑 Вільно: ${free}`,
        waiting > 0
            ? `⏳ Очікують: ${waiting}`
            : undefined,
        `🔻 Мінімум: ${training.minPlayers}`,
        '',
        `Статус: ${status.title}`,
    ]
        .filter(
            (line): line is string =>
                line !== undefined,
        )
        .join('\n');
}

export function renderTemplateCard(
    template: TrainingTemplate,
): string {
    return [
        `${
            template.enabled
                ? '🟢'
                : '⚪️'
        } ${template.title}`,
        '',
        '🏸 Тренування',
        `📅 ${formatDay(template.dayOfWeek)}`,
        `🕐 ${formatTimeRange(
            template.startTime,
            template.endTime,
        )}`,
        template.location
            ? `📍 ${template.location}`
            : undefined,
        '',
        `👥 Місць: ${template.placesLimit}`,
        `🔻 Мінімум: ${template.minPlayers}`,
        '',
        '📣 Публікація',
        `📅 ${formatDay(
            template.publishDayOfWeek,
        )}`,
        `🕐 ${template.publishTime}`,
    ]
        .filter(
            (line): line is string =>
                line !== undefined,
        )
        .join('\n');
}

export function renderPlayerCard(
    player: Player,
): string {
    return [
        `${
            player.isConfirmed
                ? '✅'
                : '⚠️'
        } ${player.displayName}`,
        '',
        player.telegramName
            ? `Telegram: ${player.telegramName}`
            : undefined,
        player.username
            ? `Username: @${player.username}`
            : undefined,
        '',
        player.isConfirmed
            ? 'Імʼя підтверджено'
            : 'Потрібно підтвердити імʼя',
        player.isActive
            ? '🟢 Активний гравець'
            : '⚪️ Неактивний гравець',
    ]
        .filter(
            (line): line is string =>
                line !== undefined,
        )
        .join('\n');
}