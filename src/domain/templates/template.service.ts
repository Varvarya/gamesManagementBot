import { RepositoriesContext } from '../../app/repositories.context';
import { nowIso } from '../../utils/date';
import { createId } from '../../utils/ids';
import {
    CreateTrainingTemplateSlotInput,
    TrainingTemplate,
    TrainingTemplateSlot,
} from './template.types';

export type CreateTemplateInput = {
    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    placesLimit: number;
    minPlayers: number;

    publishDaysBefore: number;
    publishTime: string;

    slots: CreateTrainingTemplateSlotInput[];

    enabled: boolean;
};

export type UpdateTemplateInput = {
    title?: string;
    location?: string;
    chatId?: number;

    placesLimit?: number;
    minPlayers?: number;

    publishDaysBefore?: number;
    publishTime?: string;

    slots?: Array<
        TrainingTemplateSlot |
        CreateTrainingTemplateSlotInput
    >;

    enabled?: boolean;
};

export class TemplateService {
    constructor(
        private readonly repositories: RepositoriesContext,
    ) {}

    async create(
        input: CreateTemplateInput,
    ): Promise<TrainingTemplate> {
        this.validateCommonFields({
            placesLimit: input.placesLimit,
            minPlayers: input.minPlayers,
            publishDaysBefore:
            input.publishDaysBefore,
            publishTime: input.publishTime,
        });

        this.validateSlots(
            input.slots,
            input.placesLimit,
            input.minPlayers,
            input.publishDaysBefore,
            input.publishTime,
        );

        const now = nowIso();

        const template: TrainingTemplate = {
            id: createId('template'),
            clubId: input.clubId,
            chatId: input.chatId,

            title: input.title.trim(),
            location:
                input.location?.trim() ||
                undefined,

            placesLimit: input.placesLimit,
            minPlayers: input.minPlayers,

            publishDaysBefore:
            input.publishDaysBefore,
            publishTime: input.publishTime,

            slots: input.slots.map(
                slot => ({
                    ...slot,
                    id: createId('slot'),
                    enabled:
                        slot.enabled ?? true,
                }),
            ),

            enabled:
                input.enabled ?? true,

            createdAt: now,
            updatedAt: now,
        };

        return this.repositories.templates.save(
            template,
        );
    }

    async update(
        templateId: string,
        input: UpdateTemplateInput,
    ): Promise<TrainingTemplate> {
        const template =
            await this.getRequired(
                templateId,
            );

        const placesLimit =
            input.placesLimit ??
            template.placesLimit;

        const minPlayers =
            input.minPlayers ??
            template.minPlayers;

        const publishDaysBefore =
            input.publishDaysBefore ??
            template.publishDaysBefore;

        const publishTime =
            input.publishTime ??
            template.publishTime;

        const slots =
            input.slots ??
            template.slots;

        this.validateCommonFields({
            placesLimit,
            minPlayers,
            publishDaysBefore,
            publishTime,
        });

        this.validateSlots(
            slots,
            placesLimit,
            minPlayers,
            publishDaysBefore,
            publishTime,
        );

        Object.assign(
            template,
            input,
        );

        template.title =
            template.title.trim();

        template.location =
            template.location?.trim() ||
            undefined;

        template.slots = slots.map(
            slot => ({
                ...slot,

                id:
                    'id' in slot &&
                    slot.id
                        ? slot.id
                        : createId('slot'),

                enabled:
                    slot.enabled ?? true,
            }),
        );

        template.updatedAt =
            nowIso();

        return this.repositories.templates.save(
            template,
        );
    }

    async enable(
        templateId: string,
    ): Promise<TrainingTemplate> {
        return this.update(
            templateId,
            {
                enabled: true,
            },
        );
    }

    async disable(
        templateId: string,
    ): Promise<TrainingTemplate> {
        return this.update(
            templateId,
            {
                enabled: false,
            },
        );
    }

    async listByClubId(
        clubId: string,
    ): Promise<TrainingTemplate[]> {
        return this.repositories.templates.listByClubId(
            clubId,
        );
    }

    async getRequired(
        templateId: string,
    ): Promise<TrainingTemplate> {
        const template =
            await this.repositories.templates.findById(
                templateId,
            );

        if (!template) {
            throw new Error(
                `Template ${templateId} not found`,
            );
        }

        return template;
    }

    async delete(
        templateId: string,
    ): Promise<void> {
        await this.repositories.templates.delete(
            templateId,
        );
    }

    private validateCommonFields(
        input: {
            placesLimit: number;
            minPlayers: number;
            publishDaysBefore: number;
            publishTime: string;
        },
    ): void {
        if (input.placesLimit < 1) {
            throw new Error(
                'placesLimit must be greater than 0',
            );
        }

        if (input.minPlayers < 0) {
            throw new Error(
                'minPlayers can not be negative',
            );
        }

        if (
            input.minPlayers >
            input.placesLimit
        ) {
            throw new Error(
                'minPlayers can not exceed placesLimit',
            );
        }

        if (
            !Number.isInteger(
                input.publishDaysBefore,
            ) ||
            input.publishDaysBefore < 0
        ) {
            throw new Error(
                'publishDaysBefore must be a non-negative integer',
            );
        }

        this.validateTime(
            input.publishTime,
        );
    }

    private validateSlots(
        slots: Array<
            TrainingTemplateSlot |
            CreateTrainingTemplateSlotInput
        >,
        defaultPlacesLimit: number,
        defaultMinPlayers: number,
        defaultPublishDaysBefore: number,
        defaultPublishTime: string,
    ): void {
        if (slots.length === 0) {
            throw new Error(
                'Template must contain at least one slot',
            );
        }

        for (const slot of slots) {
            this.validateDayOfWeek(
                slot.dayOfWeek,
            );

            this.validateTime(
                slot.startTime,
            );

            this.validateTime(
                slot.endTime,
            );

            if (
                this.timeToMinutes(
                    slot.endTime,
                ) <=
                this.timeToMinutes(
                    slot.startTime,
                )
            ) {
                throw new Error(
                    'Slot endTime must be later than startTime',
                );
            }

            const placesLimit =
                slot.placesLimit ??
                defaultPlacesLimit;

            const minPlayers =
                slot.minPlayers ??
                defaultMinPlayers;

            const publishDaysBefore =
                slot.publishDaysBefore ??
                defaultPublishDaysBefore;

            const publishTime =
                slot.publishTime ??
                defaultPublishTime;

            this.validateCommonFields({
                placesLimit,
                minPlayers,
                publishDaysBefore,
                publishTime,
            });
        }
    }

    private validateDayOfWeek(
        dayOfWeek: number,
    ): void {
        if (
            !Number.isInteger(dayOfWeek) ||
            dayOfWeek < 1 ||
            dayOfWeek > 7
        ) {
            throw new Error(
                'dayOfWeek must be from 1 to 7',
            );
        }
    }

    private validateTime(
        time: string,
    ): void {
        if (
            !/^\d{2}:\d{2}$/.test(
                time,
            )
        ) {
            throw new Error(
                `Invalid time format: ${time}`,
            );
        }

        const [
            hoursRaw,
            minutesRaw,
        ] = time.split(':');

        const hours =
            Number(hoursRaw);

        const minutes =
            Number(minutesRaw);

        if (
            hours < 0 ||
            hours > 23 ||
            minutes < 0 ||
            minutes > 59
        ) {
            throw new Error(
                `Invalid time: ${time}`,
            );
        }
    }

    private timeToMinutes(
        time: string,
    ): number {
        const [
            hours,
            minutes,
        ] = time
            .split(':')
            .map(Number);

        return (
            hours * 60 +
            minutes
        );
    }
}