import { ChatsRepository } from '../storage/repositories/chats.repository';
import { LogsRepository } from '../storage/repositories/logs.repository';
import { PlayersRepository } from '../storage/repositories/players.repository';
import { SettingsRepository } from '../storage/repositories/settings.repository';
import { TemplatesRepository } from '../storage/repositories/templates.repository';
import { TrainingsRepository } from '../storage/repositories/trainings.repository';
import { JsonStorage } from '../storage/jsonStorage';
import { logger } from '../utils/logger';
import { ClubSettings } from '../domain/settings/settings.types';
import { Player } from '../domain/players/player.types';
import { Training } from '../domain/trainings/training.types';

type LegacyTemplateDefaults = {
    defaultPlacesLimit?: number;
    defaultMinPlayers?: number;
    defaultPublishDaysBefore?: number;
    defaultPublishTime?: string;
    cancelCheckHoursBefore?: number;
};

export class RepositoriesContext {
    readonly chats: ChatsRepository;
    readonly players: PlayersRepository;
    readonly trainings: TrainingsRepository;
    readonly templates: TemplatesRepository;
    readonly logs: LogsRepository;
    readonly settings: SettingsRepository;
    private readonly storagePath: string;
    private readonly diagnosticIdentity: { clubId: string; title: string; storageSlug: string };

    constructor(
        storage: JsonStorage,
        defaultTimezone = 'Europe/Kyiv',
        identity: { clubId: string; title: string; storageSlug: string } = { clubId: 'club', title: 'Club', storageSlug: 'club' },
    ) {
        this.storagePath = storage.getDirectoryPath();
        this.diagnosticIdentity = identity;
        this.chats =
            new ChatsRepository(
                storage.getFilePath(
                    'chats',
                ),
            );

        this.players =
            new PlayersRepository(
                storage.getFilePath(
                    'players',
                ),
            );

        this.trainings =
            new TrainingsRepository(
                storage.getFilePath(
                    'trainings',
                ),
            );

        this.templates =
            new TemplatesRepository(
                storage,
            );

        this.logs =
            new LogsRepository(
                storage.getFilePath(
                    'logs',
                ),
            );

        this.settings =
            new SettingsRepository(
                storage.getFilePath(
                    'settings',
                ),
                {
                    clubId: identity.clubId,
                    title: identity.title,
                    storageSlug: identity.storageSlug,

                    timezone: defaultTimezone,
                    admins: [],
                    cleanChatMode: true,

                    createdAt: Date.now().toString(),
                    updatedAt: Date.now().toString(),
                },
            );
    }

    async loadAll(): Promise<void> {
        logger.info('repositories.load_started', { ...this.diagnosticIdentity, path: this.storagePath });
        await Promise.all([
            this.chats.load(),
            this.players.load(),
            this.trainings.load(),
            this.templates.load(),
            this.logs.load(),
            this.settings.load(),
        ]);
        const settings = await this.settings.get();
        logger.info('settings.loaded', { clubId: settings.clubId, title: settings.title, storageSlug: settings.storageSlug, path: this.settings.getFilePath() });
        await this.migrateLegacyTemplateDefaults(settings);
        await this.migrateParticipantDisplayNames();
        if (settings.chatId && !(await this.chats.getById(settings.chatId))) {
            await this.chats.upsert({ id: settings.chatId, name: `Legacy chat ${settings.chatId}`, enabled: true });
            logger.info('storage.legacy_chat_migrated', { chatId: settings.chatId });
        }
        logger.info('repositories.load_completed', { clubId: settings.clubId, title: settings.title, storageSlug: settings.storageSlug, path: this.storagePath });
    }

    private async migrateParticipantDisplayNames(): Promise<void> {
        const [trainings, players] = await Promise.all([
            this.trainings.list(),
            this.players.list(),
        ]);
        const migratedEntries = backfillParticipantDisplayNames(trainings, players);
        if (migratedEntries > 0) {
            await this.trainings.saveAll(trainings);
            logger.info('storage.participant_display_names_migrated', { migratedEntries });
        }
    }

    private async migrateLegacyTemplateDefaults(settings: ClubSettings): Promise<void> {
        const legacy = settings as ClubSettings & LegacyTemplateDefaults;
        const legacyKeys: Array<keyof LegacyTemplateDefaults> = [
            'defaultPlacesLimit',
            'defaultMinPlayers',
            'defaultPublishDaysBefore',
            'defaultPublishTime',
            'cancelCheckHoursBefore',
        ];
        const hasLegacyValues = legacyKeys.some((key) => legacy[key] !== undefined);
        const templates = await this.templates.list();
        let changedTemplates = 0;

        for (const template of templates) {
            let changed = false;
            if (!Number.isInteger(template.placesLimit) || template.placesLimit < 1) {
                template.placesLimit = legacy.defaultPlacesLimit ?? 16;
                changed = true;
            }
            if (!Number.isInteger(template.minPlayers) || template.minPlayers < 0) {
                template.minPlayers = legacy.defaultMinPlayers ?? 8;
                changed = true;
            }
            if (template.minPlayers > template.placesLimit) {
                template.minPlayers = Math.min(legacy.defaultMinPlayers ?? template.placesLimit, template.placesLimit);
                changed = true;
            }
            if (!Number.isInteger(template.publishDaysBefore) || template.publishDaysBefore < 0) {
                template.publishDaysBefore = legacy.defaultPublishDaysBefore ?? 1;
                changed = true;
            }
            if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(template.publishTime ?? '')) {
                template.publishTime = legacy.defaultPublishTime ?? '18:00';
                changed = true;
            }
            if (!Number.isInteger(template.cancelCheckHoursBefore) || template.cancelCheckHoursBefore! < 0) {
                template.cancelCheckHoursBefore = legacy.cancelCheckHoursBefore ?? 4;
                changed = true;
            }
            if (changed) {
                template.updatedAt = new Date().toISOString();
                changedTemplates++;
            }
        }

        // Persist copied values first. Only after that succeeds may legacy settings be removed.
        if (changedTemplates > 0) await this.templates.saveMany(templates);
        if (hasLegacyValues) {
            const clean = { ...settings } as ClubSettings & Record<string, unknown>;
            for (const key of legacyKeys) delete clean[key];
            await this.settings.save(clean);
            logger.info('storage.club_defaults_migrated_to_templates', { templateCount: changedTemplates });
        }
    }
}

export function backfillParticipantDisplayNames(trainings: Training[], players: Player[]): number {
    const playerNames = new Map(players.map((player) => [player.id, player.displayName]));
    let migratedEntries = 0;
    for (const training of trainings) {
        for (const entry of [...training.participants, ...training.waitlist]) {
            const legacyEntry = entry as typeof entry & { displayName?: string };
            if (legacyEntry.displayName?.trim()) continue;
            legacyEntry.displayName = playerNames.get(entry.playerId)?.trim() || 'Гравець';
            migratedEntries += 1;
        }
    }
    return migratedEntries;
}
