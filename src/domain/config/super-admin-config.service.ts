import { randomUUID } from 'node:crypto';

import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingTemplate } from '../templates/template.types';
import { TemplateSchedulerService } from '../templates/template-scheduler.service';
import {
    ImportedClubConfig,
    ImportedTemplateConfig,
    ImportPreview,
    ImportSectionPreview,
} from './config.types';
import { BackupService, BackupResult } from '../../storage/backup.service';
import { ClubSettings } from '../settings/settings.types';

export class SuperAdminConfigService {
    constructor(
        private readonly repositories: RepositoriesContext,
        private readonly templateScheduler: TemplateSchedulerService,
        private readonly backups?: BackupService,
    ) {}

    async exportConfig(): Promise<ImportedClubConfig> {
        const [settings, chats, players, templates] = await Promise.all([
            this.repositories.settings.get(),
            this.repositories.chats.getAll(),
            this.repositories.players.list(),
            this.repositories.templates.list(),
        ]);
        return {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            data: {
                settings: structuredClone(settings),
                chats: structuredClone(chats),
                players: structuredClone(players),
                templates: structuredClone(templates),
            },
        };
    }

    async previewImport(config: ImportedClubConfig): Promise<ImportPreview> {
        this.validateConfig(config);
        const [settings, chats, players, templates] = await Promise.all([
            this.repositories.settings.get(),
            this.repositories.chats.getAll(),
            this.repositories.players.list(),
            this.repositories.templates.list(),
        ]);
        if (!config.data) {
            return {
                mode: 'legacy',
                settingsChanged: Boolean(config.club),
                chats: emptyPreview(chats.length),
                players: emptyPreview(players.length),
                templates: { current: templates.length, incoming: config.templates?.length ?? 0, added: config.templates?.length ?? 0, updated: 0, removed: 0 },
            };
        }
        return {
            mode: 'snapshot',
            settingsChanged: JSON.stringify(settings) !== JSON.stringify(config.data.settings),
            chats: compareByKey(chats, config.data.chats, (item) => String(item.id)),
            players: compareByKey(players, config.data.players, (item) => item.id),
            templates: compareByKey(templates, config.data.templates, (item) => item.id),
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
        this.validateConfig(config);
        if (config.data) {
            await this.importSnapshot(config);
            return;
        }
        const currentSettings = await this.repositories.settings.get();
        if ((config.templates?.length ?? 0) > 0 && !(config.club?.chatId ?? currentSettings.chatId)) throw new Error('chatId is required to import templates');
        if (!this.backups) throw new Error('Backup service is required before import');
        await this.backups.create();
        const settingsSnapshot = structuredClone(currentSettings);
        const templatesSnapshot = await this.repositories.templates.list();
        try {
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

            settings.cleanChatMode = config.club.cleanChatMode ?? settings.cleanChatMode;

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

                cancelCheckHoursBefore:
                    config.club?.cancelCheckHoursBefore ?? 4,

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
        } catch (error) {
            await this.repositories.templates.replaceAll(templatesSnapshot);
            await this.repositories.settings.save(settingsSnapshot);
            await this.templateScheduler.restore(templatesSnapshot.filter((template) => template.enabled));
            throw new Error('Import failed; previous configuration was restored', { cause: error });
        }
    }

    private async importSnapshot(config: ImportedClubConfig): Promise<void> {
        const incoming = config.data!;
        if (!this.backups) throw new Error('Backup service is required before import');
        const [settingsSnapshot, chatsSnapshot, playersSnapshot, templatesSnapshot] = await Promise.all([
            this.repositories.settings.get().then((value) => structuredClone(value)),
            this.repositories.chats.getAll(),
            this.repositories.players.list(),
            this.repositories.templates.list(),
        ]);
        await this.backups.create();
        try {
            await this.repositories.settings.save(structuredClone(incoming.settings));
            await this.repositories.chats.replaceAll(structuredClone(incoming.chats));
            await this.repositories.players.saveAll(structuredClone(incoming.players));
            await this.repositories.templates.replaceAll(structuredClone(incoming.templates));
            await this.templateScheduler.restore(incoming.templates.filter((template) => template.enabled));
        } catch (error) {
            await this.repositories.settings.save(settingsSnapshot);
            await this.repositories.chats.replaceAll(chatsSnapshot);
            await this.repositories.players.saveAll(playersSnapshot);
            await this.repositories.templates.replaceAll(templatesSnapshot);
            await this.templateScheduler.restore(templatesSnapshot.filter((template) => template.enabled));
            throw new Error('Import failed; previous data was restored', { cause: error });
        }
    }

    async createBackup(): Promise<BackupResult> {
        if (!this.backups) throw new Error('Backup service is not configured');
        const result = await this.backups.create();
        const settings = await this.repositories.settings.get();
        settings.lastBackupAt = result.createdAt;
        settings.updatedAt = new Date().toISOString();
        await this.repositories.settings.save(settings);
        return result;
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
        if (config.data) {
            this.validateSnapshot(config);
            return;
        }
        if (
            config.club?.timezone !== undefined
        ) {
            try { new Intl.DateTimeFormat('en', { timeZone: config.club.timezone }).format(); }
            catch { throw new Error('club.timezone is invalid'); }
        }

        const club = config.club;
        if (club?.defaultPlacesLimit !== undefined && (!Number.isInteger(club.defaultPlacesLimit) || club.defaultPlacesLimit < 1)) throw new Error('club.defaultPlacesLimit must be greater than 0');
        if (club?.defaultMinPlayers !== undefined && (!Number.isInteger(club.defaultMinPlayers) || club.defaultMinPlayers < 0)) throw new Error('club.defaultMinPlayers must be non-negative');
        const places = club?.defaultPlacesLimit;
        const minimum = club?.defaultMinPlayers;
        if (places !== undefined && minimum !== undefined && minimum > places) throw new Error('club.defaultMinPlayers must not exceed defaultPlacesLimit');
        if (club?.defaultPublishDaysBefore !== undefined && (!Number.isInteger(club.defaultPublishDaysBefore) || club.defaultPublishDaysBefore < 0)) throw new Error('club.defaultPublishDaysBefore must be non-negative');
        if (club?.defaultPublishTime !== undefined) this.validateTime(club.defaultPublishTime, 'club.defaultPublishTime');

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

    private validateSnapshot(config: ImportedClubConfig): void {
        if (config.schemaVersion !== 1) throw new Error('Unsupported or missing schemaVersion');
        const data = config.data;
        if (!data || !data.settings || !Array.isArray(data.chats) || !Array.isArray(data.players) || !Array.isArray(data.templates)) throw new Error('Import data must contain settings, chats, players and templates');
        const settings = data.settings;
        if (typeof settings.clubId !== 'string' || !settings.clubId.trim() || typeof settings.title !== 'string' || !settings.title.trim() || !Array.isArray(settings.admins)) throw new Error('settings schema is invalid');
        this.validateSettingsValues(settings);
        assertUnique(data.chats.map((chat) => String(chat.id)), 'chat id');
        for (const chat of data.chats) {
            if (!Number.isSafeInteger(chat.id) || typeof chat.name !== 'string' || !chat.name.trim() || typeof chat.enabled !== 'boolean') throw new Error('chat schema is invalid');
        }
        assertUnique(data.players.map((player) => player.id), 'player id');
        assertUnique(data.players.flatMap((player) => player.telegramUserId === undefined ? [] : [String(player.telegramUserId)]), 'Telegram user id');
        for (const player of data.players) {
            if (typeof player.id !== 'string' || !player.id || typeof player.displayName !== 'string' || !player.displayName.trim() || !Array.isArray(player.aliases) || player.aliases.some((alias) => typeof alias !== 'string') || typeof player.isConfirmed !== 'boolean' || typeof player.isActive !== 'boolean') throw new Error('player schema is invalid');
        }
        assertUnique(data.templates.map((template) => template.id), 'template id');
        const chatIds = new Set(data.chats.map((chat) => chat.id));
        for (const template of data.templates) {
            if (typeof template.id !== 'string' || !template.id || typeof template.clubId !== 'string' || typeof template.title !== 'string' || !template.title.trim() || !chatIds.has(template.chatId) || !Array.isArray(template.slots) || template.slots.length === 0) throw new Error('template schema is invalid or references an unknown chat');
            if (!Number.isInteger(template.placesLimit) || template.placesLimit < 1 || !Number.isInteger(template.minPlayers) || template.minPlayers < 0 || template.minPlayers > template.placesLimit) throw new Error('template limits are invalid');
            if (!Number.isInteger(template.publishDaysBefore) || template.publishDaysBefore < 0) throw new Error('template publication days are invalid');
            this.validateTime(template.publishTime, 'template.publishTime');
            if (template.cancelCheckHoursBefore !== undefined && (!Number.isInteger(template.cancelCheckHoursBefore) || template.cancelCheckHoursBefore < 0)) throw new Error('template cancellation check time is invalid');
            assertUnique(template.slots.map((slot) => slot.id), `slot id in template ${template.id}`);
            for (const slot of template.slots) {
                if (typeof slot.id !== 'string' || !slot.id || typeof slot.enabled !== 'boolean') throw new Error('template slot schema is invalid');
                this.validateDay(slot.dayOfWeek, 'slot.dayOfWeek');
                this.validateTime(slot.startTime, 'slot.startTime');
                this.validateTime(slot.endTime, 'slot.endTime');
                if (this.timeToMinutes(slot.endTime) <= this.timeToMinutes(slot.startTime)) throw new Error('slot.endTime must be later than startTime');
                if (slot.publishTime !== undefined) this.validateTime(slot.publishTime, 'slot.publishTime');
            }
        }
    }

    private validateSettingsValues(settings: ClubSettings): void {
        try { new Intl.DateTimeFormat('en', { timeZone: settings.timezone }).format(); }
        catch { throw new Error('settings.timezone is invalid'); }
        if (typeof settings.cleanChatMode !== 'boolean') throw new Error('settings schema is invalid');
        if (settings.admins.some((admin) => !Number.isSafeInteger(admin.telegramUserId) || !['owner', 'admin'].includes(admin.role))) throw new Error('settings.admins schema is invalid');
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

function emptyPreview(current: number): ImportSectionPreview {
    return { current, incoming: 0, added: 0, updated: 0, removed: 0 };
}

function compareByKey<T>(current: T[], incoming: T[], key: (item: T) => string): ImportSectionPreview {
    const currentById = new Map(current.map((item) => [key(item), item]));
    const incomingById = new Map(incoming.map((item) => [key(item), item]));
    let added = 0;
    let updated = 0;
    for (const [id, item] of incomingById) {
        const existing = currentById.get(id);
        if (!existing) added += 1;
        else if (JSON.stringify(existing) !== JSON.stringify(item)) updated += 1;
    }
    let removed = 0;
    for (const id of currentById.keys()) if (!incomingById.has(id)) removed += 1;
    return { current: current.length, incoming: incoming.length, added, updated, removed };
}

function assertUnique(values: string[], label: string): void {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
