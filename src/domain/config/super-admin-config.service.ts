import { RepositoriesContext } from '../../app/repositories.context';
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

            templates: templates.map((template) => ({
                title: template.title,
                location: template.location,

                dayOfWeek: template.dayOfWeek,

                startTime: template.startTime,
                endTime: template.endTime,

                placesLimit: template.placesLimit,
                minPlayers: template.minPlayers,

                publishDayOfWeek:
                template.publishDayOfWeek,
                publishTime: template.publishTime,

                enabled: template.enabled,
            })),
        };
    }

    parseImportJson(value: string): ImportedClubConfig {
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

        for (const importedTemplate of config.templates) {
            const chatId =
                config.club?.chatId ??
                settings.chatId;

            if (!chatId) {
                throw new Error(
                    'chatId is required to import templates',
                );
            }

            const existing =
                await this.repositories.templates.findMatching({
                    clubId: settings.clubId,
                    chatId,
                    dayOfWeek:
                    importedTemplate.dayOfWeek,
                    startTime:
                    importedTemplate.startTime,
                });

            const data = {
                chatId,

                title:
                    importedTemplate.title ??
                    this.createDefaultTemplateTitle(
                        importedTemplate,
                    ),

                location:
                importedTemplate.location,

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

                publishDayOfWeek:
                importedTemplate.publishDayOfWeek,

                publishTime:
                importedTemplate.publishTime,

                enabled:
                    importedTemplate.enabled ?? true,
            };

            if (existing) {
                await this.templateScheduler.update(
                    existing.id,
                    data,
                );
            } else {
                await this.templateScheduler.create({
                    clubId: settings.clubId,
                    ...data,
                });
            }
        }
    }

    private validateConfig(
        config: ImportedClubConfig,
    ): void {
        if (
            config.club?.chatId !== undefined &&
            !Number.isInteger(config.club.chatId)
        ) {
            throw new Error(
                'club.chatId must be an integer',
            );
        }

        if (
            config.club?.cancelCheckHoursBefore !== undefined &&
            (
                !Number.isInteger(
                    config.club.cancelCheckHoursBefore,
                ) ||
                config.club.cancelCheckHoursBefore < 0
            )
        ) {
            throw new Error(
                'club.cancelCheckHoursBefore must be a non-negative integer',
            );
        }

        for (const template of config.templates ?? []) {
            this.validateTemplate(template);
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
            this.timeToMinutes(template.endTime) <=
            this.timeToMinutes(template.startTime)
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
            !/^\d{2}:\d{2}$/.test(value)
        ) {
            throw new Error(
                `${field} must use HH:mm format`,
            );
        }

        const [hours, minutes] =
            value.split(':').map(Number);

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
            value.split(':').map(Number);

        return hours * 60 + minutes;
    }

    private createDefaultTemplateTitle(
        template: ImportedTemplateConfig,
    ): string {
        return `Тренування ${template.dayOfWeek} ${template.startTime}`;
    }
}