import { ChatsRepository } from '../storage/repositories/chats.repository';
import { LogsRepository } from '../storage/repositories/logs.repository';
import { PlayersRepository } from '../storage/repositories/players.repository';
import { SettingsRepository } from '../storage/repositories/settings.repository';
import { TemplatesRepository } from '../storage/repositories/templates.repository';
import { TrainingsRepository } from '../storage/repositories/trainings.repository';
import { JsonStorage } from '../storage/jsonStorage';

export class RepositoriesContext {
    readonly chats: ChatsRepository;
    readonly players: PlayersRepository;
    readonly trainings: TrainingsRepository;
    readonly templates: TemplatesRepository;
    readonly logs: LogsRepository;
    readonly settings: SettingsRepository;

    constructor(
        storage: JsonStorage,
    ) {
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
                    clubId: '123',
                    title: 'Default',

                    timezone: 'Europe/Kyiv',

                    admins: [],

                    cancelCheckHoursBefore: 4,
                    cleanChatMode: true,

                    createdAt: Date.now().toString(),
                    updatedAt: Date.now().toString(),
                },
            );
    }

    async loadAll(): Promise<void> {
        await Promise.all([
            this.chats.load(),
            this.players.load(),
            this.trainings.load(),
            this.templates.load(),
            this.logs.load(),
            this.settings.load(),
        ]);
    }
}