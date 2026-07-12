import { RepositoriesContext } from '../../app/repositories.context';
import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import { TrainingTemplate } from './template.types';

type CreateTemplateInput = {
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

    enabled?: boolean;
};

type UpdateTemplateInput = Partial<
    Pick<
        TrainingTemplate,
        | 'title'
        | 'location'
        | 'chatId'
        | 'dayOfWeek'
        | 'startTime'
        | 'endTime'
        | 'placesLimit'
        | 'minPlayers'
        | 'publishDayOfWeek'
        | 'publishTime'
        | 'enabled'
    >
>;

export class TemplateService {
    constructor(
        private readonly repositories: RepositoriesContext,
    ) {}

    async create(
        input: CreateTemplateInput,
    ): Promise<TrainingTemplate> {
        this.validateDayOfWeek(input.dayOfWeek);
        this.validateDayOfWeek(input.publishDayOfWeek);
        this.validateTime(input.startTime);
        this.validateTime(input.endTime);
        this.validateTime(input.publishTime);


        if (input.placesLimit < 1) {
            throw new Error('placesLimit must be greater than 0');
        }

        if (input.minPlayers < 0) {
            throw new Error('minPlayers can not be negative');
        }

        if (input.minPlayers > input.placesLimit) {
            throw new Error('minPlayers can not exceed placesLimit');
        }

        const now = nowIso();

        const template: TrainingTemplate = {
            id: createId('template'),
            clubId: input.clubId,
            chatId: input.chatId,
            title: input.title.trim(),
            location: input.location?.trim() || undefined,
            dayOfWeek: input.dayOfWeek,
            startTime: input.startTime,
            endTime: input.endTime,
            placesLimit: input.placesLimit,
            minPlayers: input.minPlayers,
            publishDayOfWeek: input.publishDayOfWeek,
            publishTime: input.publishTime,
            enabled: input.enabled ?? true,
            createdAt: now,
            updatedAt: now,
        };

        return this.repositories.templates.save(template);
    }

    async update(
        templateId: string,
        input: UpdateTemplateInput,
    ): Promise<TrainingTemplate> {
        const template = await this.getRequired(templateId);

        if (input.dayOfWeek !== undefined) {
            this.validateDayOfWeek(input.dayOfWeek);
        }

        if (input.publishDayOfWeek !== undefined) {
            this.validateDayOfWeek(input.publishDayOfWeek);
        }

        if (input.startTime !== undefined) {
            this.validateTime(input.startTime);
        }

        if (input.publishTime !== undefined) {
            this.validateTime(input.publishTime);
        }

        if (input.endTime !== undefined) {
            this.validateTime(input.endTime);
        }

        if (
            input.placesLimit !== undefined &&
            input.placesLimit < 1
        ) {
            throw new Error('placesLimit must be greater than 0');
        }

        if (
            input.minPlayers !== undefined &&
            input.minPlayers < 0
        ) {
            throw new Error('minPlayers can not be negative');
        }

        Object.assign(template, input);

        if (template.minPlayers > template.placesLimit) {
            throw new Error('minPlayers can not exceed placesLimit');
        }

        template.title = template.title.trim();
        template.location =
            template.location?.trim() || undefined;
        template.updatedAt = nowIso();

        return this.repositories.templates.save(template);
    }

    async enable(templateId: string): Promise<TrainingTemplate> {
        return this.update(templateId, {
            enabled: true,
        });
    }

    async disable(templateId: string): Promise<TrainingTemplate> {
        return this.update(templateId, {
            enabled: false,
        });
    }

    async listByClubId(
        clubId: string,
    ): Promise<TrainingTemplate[]> {
        return this.repositories.templates.listByClubId(clubId);
    }

    async getRequired(
        templateId: string,
    ): Promise<TrainingTemplate> {
        const template =
            await this.repositories.templates.findById(templateId);

        if (!template) {
            throw new Error(`Template ${templateId} not found`);
        }

        return template;
    }

    async delete(templateId: string): Promise<void> {
        await this.repositories.templates.delete(templateId);
    }

    private validateDayOfWeek(dayOfWeek: number): void {
        if (
            !Number.isInteger(dayOfWeek) ||
            dayOfWeek < 1 ||
            dayOfWeek > 7
        ) {
            throw new Error('dayOfWeek must be from 1 to 7');
        }
    }

    private validateTime(time: string): void {
        if (!/^\d{2}:\d{2}$/.test(time)) {
            throw new Error(`Invalid time format: ${time}`);
        }

        const [hoursRaw, minutesRaw] = time.split(':');

        const hours = Number(hoursRaw);
        const minutes = Number(minutesRaw);

        if (
            hours < 0 ||
            hours > 23 ||
            minutes < 0 ||
            minutes > 59
        ) {
            throw new Error(`Invalid time: ${time}`);
        }
    }
}