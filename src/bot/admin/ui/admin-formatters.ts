import { Player } from '../../../domain/players/player.types';
import { ChatConfig } from '../../../domain/chats/chat.types';
import { TrainingTemplate, TrainingTemplateSlot } from '../../../domain/templates/template.types';
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

export function renderChatCard(
    chat: ChatConfig,
): string {
    return [
        `${chat.enabled ? '🟢' : '⚪️'} ${chat.name}`,
        '',
        `Telegram ID: ${chat.id}`,
        `Статус: ${chat.enabled ? 'увімкнено' : 'вимкнено'}`,
    ].join('\n');
}

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

/** Formats internal recurring slots as compact, user-facing schedule lines. */
export function formatScheduleLines(slots: readonly TrainingTemplateSlot[]): string[] {
    const byTime = new Map<string, { startTime: string; endTime: string; days: number[] }>();
    for (const slot of slots) {
        const key = `${slot.startTime}\u0000${slot.endTime}`;
        const group = byTime.get(key) ?? { startTime: slot.startTime, endTime: slot.endTime, days: [] };
        if (!group.days.includes(slot.dayOfWeek)) group.days.push(slot.dayOfWeek);
        byTime.set(key, group);
    }
    return [...byTime.values()]
        .map((group) => ({ ...group, days: group.days.sort((a, b) => a - b) }))
        .sort((a, b) => (a.days[0] ?? 8) - (b.days[0] ?? 8) || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime))
        .map((group) => `${formatDaySet(group.days)} · ${formatTimeRange(group.startTime, group.endTime)}`);
}

export function renderScheduleOverview(templates: readonly TrainingTemplate[]): string {
    if (!templates.length) return '📅 Розклад\n\nРозклад поки порожній.';
    return ['📅 Розклад', '', ...templates.flatMap((template, index) => {
        const lines = formatScheduleLines(template.slots);
        return [
            `${template.enabled ? '🟢' : '⚪'} ${template.title}`,
            ...(lines.length ? lines : ['Час не налаштовано']),
            ...(!template.enabled ? ['⏸ Пауза'] : []),
            ...(index < templates.length - 1 ? [''] : []),
        ];
    })].join('\n');
}

function formatDaySet(days: readonly number[]): string {
    if (days.length >= 3 && days.every((day, index) => index === 0 || day === days[index - 1] + 1)) {
        return `${formatShortDay(days[0])}–${formatShortDay(days[days.length - 1])}`;
    }
    return days.map(formatShortDay).join(', ');
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

        case 'archived':
            return {
                icon: '📦',
                title: 'В архіві',
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
    options: { playerNames?: ReadonlyMap<string, string>; chatName?: string; showAll?: boolean } = {},
): string {
    const status = getTrainingStatus(training);
    const registered = countTrainingPlaces(training);
    const participantLimit = options.showAll ? training.participants.length : 10;
    const waitlistLimit = options.showAll ? training.waitlist.length : 5;
    const participantLines = renderParticipantNames(training.participants, options.playerNames, participantLimit);
    const waitlistLines = renderParticipantNames(training.waitlist, options.playerNames, waitlistLimit);

    return [
        `🏸 ${training.title}`,
        `${formatDate(training.date)} · ${formatTimeRange(training.startTime, training.endTime)}`,
        training.location
            ? `📍 ${training.location}`
            : undefined,
        '',
        `${status.icon} ${status.title}`,
        training.status === 'cancelled' ? `${registered} місць було записано` : `${registered}/${training.placesLimit}`,
        '',
        ...participantLines,
        ...(training.waitlist.length ? ['', '⏳ Очікують', ...waitlistLines] : []),
        ...(training.publicationStale ? ['', '⚠️ Повідомлення в чаті недоступне'] : []),
    ]
        .filter(
            (line): line is string =>
                line !== undefined,
        )
        .join('\n');
}

export function isTrainingParticipantListTruncated(training: Training): boolean {
    return training.participants.length > 10 || training.waitlist.length > 5;
}

function renderParticipantNames(entries: Training['participants'], names: ReadonlyMap<string, string> | undefined, limit: number): string[] {
    if (entries.length === 0) return [];
    const visible: string[] = [];
    let number = 1;
    for (const entry of entries) {
        if (visible.length >= limit) break;
        visible.push(`${number++}. ${names?.get(entry.playerId) ?? entry.displayName ?? 'Гравець'}`);
        for (let place = 1; place < entry.places && visible.length < limit; place++) visible.push(`${number++}. +1`);
    }
    const hidden = entries.reduce((sum, entry) => sum + entry.places, 0) - visible.length;
    if (hidden > 0) visible.push(`… ще ${hidden}`);
    return visible;
}

export function renderTemplateCard(
    template: TrainingTemplate,
    chatName?: string,
): string {
    const scheduleLines = formatScheduleLines(template.slots);
    const publication = template.publishDaysBefore === 1 ? `напередодні о ${template.publishTime}` : `за ${template.publishDaysBefore} дн. о ${template.publishTime}`;

    return [
        `🏸 ${template.title}`,
        template.location
            ? `📍 ${template.location}`
            : undefined,
        '',
        ...(scheduleLines.length ? scheduleLines : ['Час не налаштовано']),
        '',
        `👥 Місць: ${template.placesLimit}`,
        `🎯 Мінімум: ${template.minPlayers}`,
        '',
        `📣 Публікація:\n${publication}`,
        '',
        `💬 Чат:\n${chatName ?? template.chatId}`,
        '',
        template.enabled ? '🟢 Активне' : '⏸ Пауза',
    ]
        .filter(
            (line): line is string =>
                line !== undefined,
        )
        .join('\n');
}

export function renderPlayerCard(
    player: Player,
    options: { currentTrainings?: Training[]; registrationHistory?: Training[] } = {},
): string {
    return [
        `👤 ${player.displayName}`,
        '',
        `Статус: ${player.isConfirmed ? '✅ Підтверджено' : '⚠️ Не підтверджено'}`,
        `Активність: ${player.isActive ? '🟢 Активна' : '⛔ Неактивна'}`,
        `Telegram: ${player.username ? `@${player.username}` : player.telegramName ?? '—'}`,
        '',
        'Aliases:',
        ...(player.aliases.length ? player.aliases.map((alias) => `- ${alias}`) : ['—']),
        '',
        'Поточні тренування:',
        ...(options.currentTrainings?.length ? options.currentTrainings.slice(0, 5).map((training) => `- ${formatDate(training.date)}, ${training.startTime} · ${training.title}`) : ['—']),
        '',
        `Історія реєстрацій: ${options.registrationHistory?.length ?? 0}`,
    ]
        .filter(
            (line): line is string =>
                line !== undefined,
        )
        .join('\n');
}
