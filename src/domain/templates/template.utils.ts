import {
    TrainingTemplate,
    TrainingTemplateSlot,
} from './template.types';

export type ResolvedTrainingTemplateSlot = {
    id: string;

    dayOfWeek: number;

    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;

    publishDaysBefore: number;
    publishTime: string;

    enabled: boolean;
};

export function resolveTemplateSlot(
    template: TrainingTemplate,
    slot: TrainingTemplateSlot,
): ResolvedTrainingTemplateSlot {
    return {
        id: slot.id,

        dayOfWeek: slot.dayOfWeek,

        startTime: slot.startTime,
        endTime: slot.endTime,

        placesLimit:
            slot.placesLimit ??
            template.placesLimit,

        minPlayers:
            slot.minPlayers ??
            template.minPlayers,

        publishDaysBefore:
            slot.publishDaysBefore ??
            template.publishDaysBefore,

        publishTime:
            slot.publishTime ??
            template.publishTime,

        enabled:
            template.enabled &&
            slot.enabled,
    };
}

export function resolveTemplateSlots(
    template: TrainingTemplate,
): ResolvedTrainingTemplateSlot[] {
    return template.slots.map((slot) =>
        resolveTemplateSlot(
            template,
            slot,
        ),
    );
}

export function validateTemplateSlot(
    slot: ResolvedTrainingTemplateSlot,
): void {
    if (
        !Number.isInteger(slot.dayOfWeek) ||
        slot.dayOfWeek < 1 ||
        slot.dayOfWeek > 7
    ) {
        throw new Error(
            'Slot dayOfWeek must be between 1 and 7',
        );
    }

    validateTime(
        slot.startTime,
        'startTime',
    );

    validateTime(
        slot.endTime,
        'endTime',
    );

    validateTime(
        slot.publishTime,
        'publishTime',
    );

    if (
        timeToMinutes(slot.endTime) <=
        timeToMinutes(slot.startTime)
    ) {
        throw new Error(
            'Slot endTime must be later than startTime',
        );
    }

    if (
        !Number.isInteger(slot.placesLimit) ||
        slot.placesLimit < 1
    ) {
        throw new Error(
            'Slot placesLimit must be greater than 0',
        );
    }

    if (
        !Number.isInteger(slot.minPlayers) ||
        slot.minPlayers < 0 ||
        slot.minPlayers >
        slot.placesLimit
    ) {
        throw new Error(
            'Slot minPlayers must be between 0 and placesLimit',
        );
    }

    if (
        !Number.isInteger(
            slot.publishDaysBefore,
        ) ||
        slot.publishDaysBefore < 0 ||
        slot.publishDaysBefore > 30
    ) {
        throw new Error(
            'Slot publishDaysBefore must be between 0 and 30',
        );
    }
}

export function validateTrainingTemplate(
    template: TrainingTemplate,
): void {
    if (!template.title.trim()) {
        throw new Error(
            'Template title is required',
        );
    }

    if (!template.chatId) {
        throw new Error(
            'Template chatId is required',
        );
    }

    if (template.slots.length === 0) {
        throw new Error(
            'Template must contain at least one slot',
        );
    }

    const uniqueSlots = new Set<string>();

    for (
        const resolvedSlot of
        resolveTemplateSlots(template)
        ) {
        validateTemplateSlot(
            resolvedSlot,
        );

        const slotKey = [
            resolvedSlot.dayOfWeek,
            resolvedSlot.startTime,
            resolvedSlot.endTime,
        ].join(':');

        if (uniqueSlots.has(slotKey)) {
            throw new Error(
                `Duplicate template slot: ${slotKey}`,
            );
        }

        uniqueSlots.add(slotKey);
    }
}

export function validateTime(
    value: string,
    field: string,
): void {
    if (!/^\d{2}:\d{2}$/.test(value)) {
        throw new Error(
            `${field} must use HH:mm format`,
        );
    }

    const [hours, minutes] =
        value.split(':').map(Number);

    if (
        !Number.isInteger(hours) ||
        !Number.isInteger(minutes) ||
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59
    ) {
        throw new Error(
            `${field} contains invalid time`,
        );
    }
}

export function timeToMinutes(
    value: string,
): number {
    const [hours, minutes] =
        value.split(':').map(Number);

    return hours * 60 + minutes;
}