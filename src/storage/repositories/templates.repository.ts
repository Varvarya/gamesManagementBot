import { JsonStorage } from '../jsonStorage';

import {
    TrainingTemplate,
    TrainingTemplateId,
} from '../../domain/templates/template.types';

import {
    migrateTrainingTemplates,
} from '../../domain/templates/template.migration';

const STORAGE_KEY = 'templates.json';

export class TemplatesRepository {
    private items: TrainingTemplate[] = [];

    constructor(
        private readonly storage: JsonStorage,
    ) {}

    async load(): Promise<void> {
        const raw =
            await this.storage.read<unknown>(
                STORAGE_KEY,
                [],
            );

        this.items =
            migrateTrainingTemplates(raw);

        /*
         * Одразу записуємо мігрований формат,
         * щоб наступні запуски вже читали slots[].
         */
        await this.persist();
    }

    async list(): Promise<TrainingTemplate[]> {
        return this.items.map(
            (template) =>
                this.clone(template),
        );
    }

    async listByClubId(
        clubId: string,
    ): Promise<TrainingTemplate[]> {
        return this.items
            .filter(
                (template) =>
                    template.clubId === clubId,
            )
            .map(
                (template) =>
                    this.clone(template),
            );
    }

    async listEnabled(): Promise<TrainingTemplate[]> {
        return this.items
            .filter(
                (template) =>
                    template.enabled,
            )
            .map(
                (template) =>
                    this.clone(template),
            );
    }

    async listEnabledByClubId(
        clubId: string,
    ): Promise<TrainingTemplate[]> {
        return this.items
            .filter(
                (template) =>
                    template.clubId === clubId &&
                    template.enabled,
            )
            .map(
                (template) =>
                    this.clone(template),
            );
    }

    async findById(
        templateId: TrainingTemplateId,
    ): Promise<TrainingTemplate | undefined> {
        const template =
            this.items.find(
                (item) =>
                    item.id === templateId,
            );

        return template
            ? this.clone(template)
            : undefined;
    }

    async getRequired(
        templateId: TrainingTemplateId,
    ): Promise<TrainingTemplate> {
        const template =
            await this.findById(templateId);

        if (!template) {
            throw new Error(
                `Training template ${templateId} not found`,
            );
        }

        return template;
    }

    async save(
        template: TrainingTemplate,
    ): Promise<TrainingTemplate> {
        const index =
            this.items.findIndex(
                (item) =>
                    item.id === template.id,
            );

        const stored =
            this.clone(template);

        if (index === -1) {
            this.items.push(stored);
        } else {
            this.items[index] = stored;
        }

        await this.persist();

        return this.clone(stored);
    }

    async saveMany(
        templates: TrainingTemplate[],
    ): Promise<TrainingTemplate[]> {
        for (const template of templates) {
            const index =
                this.items.findIndex(
                    (item) =>
                        item.id === template.id,
                );

            const stored =
                this.clone(template);

            if (index === -1) {
                this.items.push(stored);
            } else {
                this.items[index] = stored;
            }
        }

        await this.persist();

        return templates.map(
            (template) =>
                this.clone(template),
        );
    }

    async delete(
        templateId: TrainingTemplateId,
    ): Promise<boolean> {
        const initialLength =
            this.items.length;

        this.items =
            this.items.filter(
                (template) =>
                    template.id !== templateId,
            );

        const deleted =
            this.items.length !==
            initialLength;

        if (deleted) {
            await this.persist();
        }

        return deleted;
    }

    async deleteByClubId(
        clubId: string,
    ): Promise<number> {
        const initialLength =
            this.items.length;

        this.items =
            this.items.filter(
                (template) =>
                    template.clubId !== clubId,
            );

        const deletedCount =
            initialLength -
            this.items.length;

        if (deletedCount > 0) {
            await this.persist();
        }

        return deletedCount;
    }

    /**
     * Використовується для import/upsert.
     *
     * Шаблон вважається відповідним,
     * якщо він належить тому самому клубу,
     * чату та має таку саму назву.
     */
    async findMatching(input: {
        clubId: string;
        chatId: number;
        title: string;
    }): Promise<TrainingTemplate | undefined> {
        const normalizedTitle =
            input.title
                .trim()
                .toLocaleLowerCase('uk');

        const template =
            this.items.find(
                (item) =>
                    item.clubId ===
                    input.clubId &&
                    item.chatId ===
                    input.chatId &&
                    item.title
                        .trim()
                        .toLocaleLowerCase(
                            'uk',
                        ) ===
                    normalizedTitle,
            );

        return template
            ? this.clone(template)
            : undefined;
    }

    /**
     * Пошук шаблону, який містить конкретний слот.
     * Зручно для перевірки дублікатів при імпорті.
     */
    async findBySlot(input: {
        clubId: string;
        chatId: number;
        dayOfWeek: number;
        startTime: string;
        endTime?: string;
    }): Promise<TrainingTemplate | undefined> {
        const template =
            this.items.find(
                (item) =>
                    item.clubId ===
                    input.clubId &&
                    item.chatId ===
                    input.chatId &&
                    item.slots.some(
                        (slot) =>
                            slot.dayOfWeek ===
                            input.dayOfWeek &&
                            slot.startTime ===
                            input.startTime &&
                            (
                                input.endTime ===
                                undefined ||
                                slot.endTime ===
                                input.endTime
                            ),
                    ),
            );

        return template
            ? this.clone(template)
            : undefined;
    }

    async replaceAll(
        templates: TrainingTemplate[],
    ): Promise<void> {
        this.items =
            templates.map(
                (template) =>
                    this.clone(template),
            );

        await this.persist();
    }

    private async persist(): Promise<void> {
        await this.storage.write(
            STORAGE_KEY,
            this.items,
        );
    }

    private clone(
        template: TrainingTemplate,
    ): TrainingTemplate {
        return {
            ...template,

            slots: template.slots.map(
                (slot) => ({
                    ...slot,
                }),
            ),
        };
    }
}