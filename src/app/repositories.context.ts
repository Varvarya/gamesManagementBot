import { JsonStorage } from '../storage/jsonStorage';

export class RepositoriesContext {
    constructor(
        public readonly storage: JsonStorage,
    ) {}

    async loadAll(): Promise<void> {
        await this.storage.loadAll();
    }

    get players(): JsonStorage['players'] {
        return this.storage.players;
    }

    get trainings(): JsonStorage['trainings'] {
        return this.storage.trainings;
    }

    get templates(): JsonStorage['templates'] {
        return this.storage.templates;
    }

    get logs(): JsonStorage['logs'] {
        return this.storage.logs;
    }

    get settings(): JsonStorage['settings'] {
        return this.storage.settings;
    }
}