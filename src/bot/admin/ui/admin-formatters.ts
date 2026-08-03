import { Player } from '../../../domain/players/player.types';
import { ChatConfig } from '../../../domain/chats/chat.types';
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
    const waiting = countWaitlistPlaces(training);
    const free = Math.max(
        training.placesLimit - registered,
        0,
    );
    const participantLimit = options.showAll ? training.participants.length : 10;
    const waitlistLimit = options.showAll ? training.waitlist.length : 5;
    const participantLines = renderParticipantNames(training.participants, options.playerNames, participantLimit);
    const waitlistLines = renderParticipantNames(training.waitlist, options.playerNames, waitlistLimit);

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
        `💬 ${options.chatName ?? training.chatId}`,
        '',
        `👥 Учасники (${registered}/${training.placesLimit})`,
        ...participantLines,
        '',
        `🟡 Черга (${waiting})`,
        ...waitlistLines,
        '',
        `🪑 Вільно: ${free}`,
        `🔻 Мінімум: ${training.minPlayers}`,
        '',
        `Статус: ${status.icon} ${status.title}`,
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
    if (entries.length === 0) return ['—'];
    const visible = entries.slice(0, limit).map((entry, index) => `${index + 1}. ${names?.get(entry.playerId) ?? entry.displayName ?? 'Гравець'}`);
    const hidden = entries.length - visible.length;
    if (hidden > 0) visible.push(`… ще ${hidden}`);
    return visible;
}

export function renderTemplateCard(
    template: TrainingTemplate,
): string {
    const slotLines = template.slots.flatMap(
        (slot, index) => {
            const placesLimit =
                slot.placesLimit ??
                template.placesLimit;

            const minPlayers =
                slot.minPlayers ??
                template.minPlayers;

            const publishDaysBefore =
                slot.publishDaysBefore ??
                template.publishDaysBefore;

            const publishTime =
                slot.publishTime ??
                template.publishTime;

            return [
                index > 0
                    ? ''
                    : undefined,
                `${
                    slot.enabled
                        ? '🟢'
                        : '⚪️'
                } ${formatDay(slot.dayOfWeek)}`,
                `🕐 ${formatTimeRange(
                    slot.startTime,
                    slot.endTime,
                )}`,
                `👥 Місць: ${placesLimit}`,
                `🔻 Мінімум: ${minPlayers}`,
                `📣 За ${publishDaysBefore} дн. о ${publishTime}`,
            ];
        },
    );

    return [
        `${
            template.enabled
                ? '🟢'
                : '⚪️'
        } ${template.title}`,
        template.location
            ? `📍 ${template.location}`
            : undefined,
        '',
        '🏸 Слоти тренувань',
        ...slotLines,
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
