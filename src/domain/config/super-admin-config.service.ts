import { randomUUID } from 'node:crypto';

import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingTemplate } from '../templates/template.types';
import { TemplateSchedulerService } from '../templates/template-scheduler.service';
import {
    ImportedClubConfig,
    ImportedTemplateConfig,
} from './config.types';

export class SuperAdminConfigService {
    constructor(
        private readonly repositories: RepositoriesContext,
        private readonly templateScheduler: TemplateSchedulerService,
    ) {}

    async exportConfig(): Promise<ImportedClubConfig> {
        const settings =
            await this.repositories.settings.get();

        const templates =
            await this.repositories.templates.listByClubId(
                settings.clubId,
            );

        return {
            club: {
                title: settings.title,
                timezone: settings.timezone,
                chatId: settings.chatId,
                cancelCheckHoursBefore:
                settings.cancelCheckHoursBefore,
            },

            templates: templates.flatMap(
                template =>
                    template.slots.map(
                        slot => ({
                            title: template.title,
                            location: template.location,

                            dayOfWeek:
                            slot.dayOfWeek,

                            startTime:
                            slot.startTime,
                            endTime:
                            slot.endTime,

                            placesLimit:
                                slot.placesLimit ??
                                template.placesLimit,
                            minPlayers:
                                slot.minPlayers ??
                                template.minPlayers,

                            publishDayOfWeek:
                                this.resolvePublishDayOfWeek(
                                    slot.dayOfWeek,
                                    slot.publishDaysBefore ??
                                    template.publishDaysBefore,
                                ),

                            publishTime:
                                slot.publishTime ??
                                template.publishTime,

                            enabled:
                                template.enabled &&
                                slot.enabled,
                        }),
                    ),
            ),
        };
    }

    parseImportJson(
        value: string,
    ): ImportedClubConfig {
        let parsed: unknown;

        try {
            parsed = JSON.parse(value);
        } catch {
            throw new Error('Invalid JSON');
        }

        if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
        ) {
            throw new Error(
                'Config must be a JSON object',
            );
        }

        const config =
            parsed as ImportedClubConfig;

        this.validateConfig(config);

        return config;
    }

    async importConfig(
        config: ImportedClubConfig,
    ): Promise<void> {
        const settings =
            await this.repositories.settings.get();

        if (config.club) {
            settings.title =
                config.club.title ??
                settings.title;

            settings.timezone =
                config.club.timezone ??
                settings.timezone;

            settings.chatId =
                config.club.chatId ??
                settings.chatId;

            settings.cancelCheckHoursBefore =
                config.club.cancelCheckHoursBefore ??
                settings.cancelCheckHoursBefore;

            settings.updatedAt =
                new Date().toISOString();

            await this.repositories.settings.save(
                settings,
            );
        }

        if (!config.templates) {
            return;
        }

        const templates =
            await this.repositories.templates.listByClubId(
                settings.clubId,
            );

        for (
            const importedTemplate of
            config.templates
            ) {
            const chatId =
                config.club?.chatId ??
                settings.chatId;

            if (!chatId) {
                throw new Error(
                    'chatId is required to import templates',
                );
            }

            const existing =
                this.findMatchingTemplate(
                    templates,
                    chatId,
                    importedTemplate,
                );

            const existingSlot =
                existing?.slots.find(
                    slot =>
                        slot.dayOfWeek ===
                        importedTemplate.dayOfWeek &&
                        slot.startTime ===
                        importedTemplate.startTime,
                );

            const publishDaysBefore =
                this.resolvePublishDaysBefore(
                    importedTemplate.dayOfWeek,
                    importedTemplate.publishDayOfWeek,
                );

            const slot = {
                id:
                    existingSlot?.id ??
                    randomUUID(),

                dayOfWeek:
                importedTemplate.dayOfWeek,

                startTime:
                importedTemplate.startTime,

                endTime:
                importedTemplate.endTime,

                placesLimit:
                importedTemplate.placesLimit,

                minPlayers:
                importedTemplate.minPlayers,

                publishDaysBefore,

                publishTime:
                importedTemplate.publishTime,

                enabled:
                    importedTemplate.enabled ??
                    true,
            };

            const data = {
                chatId,

                title:
                    importedTemplate.title ??
                    this.createDefaultTemplateTitle(
                        importedTemplate,
                    ),

                location:
                importedTemplate.location,

                placesLimit:
                importedTemplate.placesLimit,

                minPlayers:
                importedTemplate.minPlayers,

                publishDaysBefore,

                publishTime:
                importedTemplate.publishTime,

                slots: [
                    slot,
                ],

                enabled:
                    importedTemplate.enabled ??
                    true,
            };

            if (existing) {
                const updated =
                    await this.templateScheduler.update(
                        existing.id,
                        data,
                    );

                const index =
                    templates.findIndex(
                        template =>
                            template.id ===
                            existing.id,
                    );

                if (index >= 0) {
                    templates[index] =
                        updated;
                }
            } else {
                const created =
                    await this.templateScheduler.create({
                        clubId:
                        settings.clubId,
                        ...data,
                    });

                templates.push(
                    created,
                );
            }
        }
    }

    private findMatchingTemplate(
        templates: TrainingTemplate[],
        chatId: number,
        importedTemplate: ImportedTemplateConfig,
    ): TrainingTemplate | undefined {
        return templates.find(
            template =>
                template.chatId ===
                chatId &&
                template.slots.some(
                    slot =>
                        slot.dayOfWeek ===
                        importedTemplate.dayOfWeek &&
                        slot.startTime ===
                        importedTemplate.startTime,
                ),
        );
    }

    private validateConfig(
        config: ImportedClubConfig,
    ): void {
        if (
            config.club?.chatId !==
            undefined &&
            !Number.isInteger(
                config.club.chatId,
            )
        ) {
            throw new Error(
                'club.chatId must be an integer',
            );
        }

        if (
            config.club
                ?.cancelCheckHoursBefore !==
            undefined &&
            (
                !Number.isInteger(
                    config.club
                        .cancelCheckHoursBefore,
                ) ||
                config.club
                    .cancelCheckHoursBefore <
                0
            )
        ) {
            throw new Error(
                'club.cancelCheckHoursBefore must be a non-negative integer',
            );
        }

        for (
            const template of
        config.templates ?? []
            ) {
            this.validateTemplate(
                template,
            );
        }
    }

    private validateTemplate(
        template: ImportedTemplateConfig,
    ): void {
        this.validateDay(
            template.dayOfWeek,
            'dayOfWeek',
        );

        this.validateDay(
            template.publishDayOfWeek,
            'publishDayOfWeek',
        );

        this.validateTime(
            template.startTime,
            'startTime',
        );

        this.validateTime(
            template.endTime,
            'endTime',
        );

        this.validateTime(
            template.publishTime,
            'publishTime',
        );

        if (
            this.timeToMinutes(
                template.endTime,
            ) <=
            this.timeToMinutes(
                template.startTime,
            )
        ) {
            throw new Error(
                'endTime must be later than startTime',
            );
        }

        if (
            !Number.isInteger(
                template.placesLimit,
            ) ||
            template.placesLimit < 1
        ) {
            throw new Error(
                'placesLimit must be greater than 0',
            );
        }

        if (
            !Number.isInteger(
                template.minPlayers,
            ) ||
            template.minPlayers < 0 ||
            template.minPlayers >
            template.placesLimit
        ) {
            throw new Error(
                'minPlayers must be between 0 and placesLimit',
            );
        }
    }

    private validateDay(
        value: number,
        field: string,
    ): void {
        if (
            !Number.isInteger(value) ||
            value < 1 ||
            value > 7
        ) {
            throw new Error(
                `${field} must be from 1 to 7`,
            );
        }
    }

    private validateTime(
        value: string,
        field: string,
    ): void {
        if (
            !/^\d{2}:\d{2}$/.test(
                value,
            )
        ) {
            throw new Error(
                `${field} must use HH:mm format`,
            );
        }

        const [hours, minutes] =
            value
                .split(':')
                .map(Number);

        if (
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

    private timeToMinutes(
        value: string,
    ): number {
        const [hours, minutes] =
            value
                .split(':')
                .map(Number);

        return (
            hours * 60 +
            minutes
        );
    }

    private resolvePublishDaysBefore(
        trainingDayOfWeek: number,
        publishDayOfWeek: number,
    ): number {
        return (
            trainingDayOfWeek -
            publishDayOfWeek +
            7
        ) % 7;
    }

    private resolvePublishDayOfWeek(
        trainingDayOfWeek: number,
        publishDaysBefore: number,
    ): number {
        return (
            (
                trainingDayOfWeek -
                publishDaysBefore -
                1 +
                700
            ) %
            7
        ) + 1;
    }

    private createDefaultTemplateTitle(
        template: ImportedTemplateConfig,
    ): string {
        return `Тренування ${template.dayOfWeek} ${template.startTime}`;
    }
}