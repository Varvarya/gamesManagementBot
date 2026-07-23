import { randomUUID } from 'node:crypto';

import {
    TrainingTemplate,
    TrainingTemplateSlot,
} from './template.types';

type LegacyTrainingTemplate = {
    id: string;

    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    dayOfWeek: number;

    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;

    publishDayOfWeek: number;
    publishTime: string;

    enabled: boolean;

    createdAt: string;
    updatedAt: string;
};

type UnknownTemplate =
    | TrainingTemplate
    | LegacyTrainingTemplate
    | Record<string, unknown>;

export function migrateTrainingTemplates(
    value: unknown,
): TrainingTemplate[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) =>
            migrateTrainingTemplate(
                item as UnknownTemplate,
            ),
        )
        .filter(
            (
                template,
            ): template is TrainingTemplate =>
                template !== undefined,
        );
}

export function migrateTrainingTemplate(
    value: UnknownTemplate,
): TrainingTemplate | undefined {
    if (
        !value ||
        typeof value !== 'object'
    ) {
        return undefined;
    }

    if (
        'slots' in value &&
        Array.isArray(value.slots)
    ) {
        return migrateCurrentTemplate(
            value as TrainingTemplate,
        );
    }

    if (
        'dayOfWeek' in value &&
        'startTime' in value &&
        'endTime' in value
    ) {
        return migrateLegacyTemplate(
            value as LegacyTrainingTemplate,
        );
    }

    return undefined;
}

function migrateCurrentTemplate(
    value: TrainingTemplate,
): TrainingTemplate {
    return {
        id: value.id,

        clubId: value.clubId,
        chatId: value.chatId,

        title: value.title,
        location: value.location,

        placesLimit:
        value.placesLimit,

        minPlayers:
        value.minPlayers,

        publishDaysBefore:
            Number.isInteger(
                value.publishDaysBefore,
            )
                ? value.publishDaysBefore
                : 1,

        publishTime:
        value.publishTime,

        slots: value.slots.map(
            migrateCurrentSlot,
        ),

        enabled:
            value.enabled !== false,

        createdAt:
        value.createdAt,

        updatedAt:
        value.updatedAt,
    };
}

function migrateCurrentSlot(
    slot: TrainingTemplateSlot,
): TrainingTemplateSlot {
    return {
        id:
            slot.id ||
            createSlotId(),

        dayOfWeek:
        slot.dayOfWeek,

        startTime:
        slot.startTime,

        endTime:
        slot.endTime,

        placesLimit:
        slot.placesLimit,

        minPlayers:
        slot.minPlayers,

        publishDaysBefore:
        slot.publishDaysBefore,

        publishTime:
        slot.publishTime,

        enabled:
            slot.enabled !== false,
    };
}

function migrateLegacyTemplate(
    value: LegacyTrainingTemplate,
): TrainingTemplate {
    const publishDaysBefore =
        calculatePublishDaysBefore(
            value.dayOfWeek,
            value.publishDayOfWeek,
        );

    return {
        id: value.id,

        clubId: value.clubId,
        chatId: value.chatId,

        title: value.title,
        location: value.location,

        placesLimit:
        value.placesLimit,

        minPlayers:
        value.minPlayers,

        publishDaysBefore,
        publishTime:
        value.publishTime,

        slots: [
            {
                id: createSlotId(),

                dayOfWeek:
                value.dayOfWeek,

                startTime:
                value.startTime,

                endTime:
                value.endTime,

                enabled: true,
            },
        ],

        enabled:
            value.enabled !== false,

        createdAt:
        value.createdAt,

        updatedAt:
        value.updatedAt,
    };
}

/**
 * Наприклад:
 *
 * тренування Пн (1),
 * публікація Нд (7)
 * => за 1 день.
 *
 * тренування Сб (6),
 * публікація Чт (4)
 * => за 2 дні.
 */
function calculatePublishDaysBefore(
    trainingDay: number,
    publishDay: number,
): number {
    const difference =
        (
            trainingDay -
            publishDay +
            7
        ) % 7;

    /**
     * Якщо день однаковий,
     * вважаємо публікацію того ж дня.
     */
    return difference;
}

function createSlotId(): string {
    return `slot_${randomUUID()}`;
}