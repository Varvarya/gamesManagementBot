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

    return value.map((item, index) => {
        const migrated = migrateTrainingTemplate(item as UnknownTemplate);
        if (!migrated) throw new Error(`Invalid training template at index ${index}; migration refused to discard it`);
        return migrated;
    });
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
        chatId: resolveChatId(value),

        title: value.title,
        location: value.location,

        placesLimit:
        value.placesLimit,

        minPlayers:
        value.minPlayers,

        // Keep a missing value visible to the cross-repository migration,
        // which can then use the club's legacy default without data loss.
        publishDaysBefore:
            value.publishDaysBefore,

        publishTime:
        value.publishTime,

        cancelCheckHoursBefore:
            Number.isInteger(value.cancelCheckHoursBefore) && value.cancelCheckHoursBefore! >= 0
                ? value.cancelCheckHoursBefore
                : undefined,

        slots: value.slots.map((slot, index) => migrateCurrentSlot(slot, value.id, index)),

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
    templateId: string,
    index: number,
): TrainingTemplateSlot {
    return {
        id:
            slot.id ||
            createSlotId(templateId, index),

        dayOfWeek:
        slot.dayOfWeek,

        startTime:
        slot.startTime,

        endTime:
        slot.endTime,

        ...(slot.placesLimit !== undefined ? { placesLimit: slot.placesLimit } : {}),
        ...(slot.minPlayers !== undefined ? { minPlayers: slot.minPlayers } : {}),
        ...(slot.publishDaysBefore !== undefined ? { publishDaysBefore: slot.publishDaysBefore } : {}),
        ...(slot.publishTime !== undefined ? { publishTime: slot.publishTime } : {}),

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
        chatId: resolveChatId(value),

        title: value.title,
        location: value.location,

        placesLimit:
        value.placesLimit,

        minPlayers:
        value.minPlayers,

        publishDaysBefore,
        publishTime:
        value.publishTime,

        cancelCheckHoursBefore: undefined,

        slots: [
            {
                id: createSlotId(value.id, 0),

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

function createSlotId(templateId: string, index: number): string {
    return `slot_${templateId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${index}`;
}

function resolveChatId(value: Record<string, unknown> | TrainingTemplate | LegacyTrainingTemplate): number {
    const record = value as Record<string, unknown>;
    const nested = record.gameChat ?? record.chat;
    const chatId = record.chatId ?? (nested && typeof nested === 'object' ? (nested as Record<string, unknown>).id : nested);
    if (!Number.isSafeInteger(chatId)) throw new Error(`Template ${String(record.id)} has no valid chatId`);
    return chatId as number;
}
