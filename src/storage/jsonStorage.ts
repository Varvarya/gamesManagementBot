import path from 'node:path';
import { nowIso } from '../utils/date';
import { PlayersRepository } from './repositories/players.repository';
import { TrainingsRepository } from './repositories/trainings.repository';
import { TemplatesRepository } from './repositories/templates.repository';
import { LogsRepository } from './repositories/logs.repository';
import { SettingsRepository } from './repositories/settings.repository';

type JsonStorageOptions = {
    dataDir: string;
    clubId: string;
};

export class JsonStorage {
    readonly players: PlayersRepository;
    readonly trainings: TrainingsRepository;
    readonly templates: TemplatesRepository;
    readonly logs: LogsRepository;
    readonly settings: SettingsRepository;

    constructor(options: JsonStorageOptions) {
        const clubDir = path.join(options.dataDir, `club-${options.clubId}`);
        const createdAt = nowIso();

        this.players = new PlayersRepository(path.join(clubDir, 'players.json'));
        this.trainings = new TrainingsRepository(
            path.join(clubDir, 'trainings.json'),
        );
        this.templates = new TemplatesRepository(
            path.join(clubDir, 'templates.json'),
        );
        this.logs = new LogsRepository(path.join(clubDir, 'logs.json'));

        this.settings = new SettingsRepository(path.join(clubDir, 'settings.json'), {
            clubId: options.clubId,
            title: 'Training Club',
            timezone: 'Europe/Kyiv',
            admins: [],
            cancelCheckHoursBefore: 3,
            cleanChatMode: false,
            createdAt,
            updatedAt: createdAt,
        });
    }

    async loadAll(): Promise<void> {
        await Promise.all([
            this.players.load(),
            this.trainings.load(),
            this.templates.load(),
            this.logs.load(),
            this.settings.load(),
        ]);
    }
}