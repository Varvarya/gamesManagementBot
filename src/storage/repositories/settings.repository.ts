import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubSettings } from '../../domain/settings/settings.types';
import { atomicWriteJson, backupBeforeMigration, readReliableJson } from '../atomicWrite';

export class SettingsRepository {
    private cache?: ClubSettings;

    constructor(
        private readonly filePath: string,
        private readonly defaultValue: ClubSettings,
    ) {}

    async load(): Promise<ClubSettings> {
        if (this.cache) return this.cache;

        await fs.mkdir(path.dirname(this.filePath), { recursive: true });

        try {
            const loaded = await readReliableJson(this.filePath, (value): value is ClubSettings => Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as ClubSettings).clubId === 'string' && typeof (value as ClubSettings).title === 'string' && Array.isArray((value as ClubSettings).admins)));
            this.cache = { ...this.defaultValue, ...loaded.data };
            const defaultsAdded = Object.keys(this.defaultValue).some((key) => !(key in loaded.data));
            if (loaded.migrated) {
                await backupBeforeMigration(this.filePath, loaded.schemaVersion);
            }
            if (loaded.migrated || defaultsAdded) await this.save(this.cache);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === 'ENOENT') {
                this.cache = this.defaultValue;
                await this.save(this.cache);
            } else throw error;
        }

        return this.cache;
    }

    async get(): Promise<ClubSettings> {
        return structuredClone(await this.load());
    }

    async save(settings: ClubSettings): Promise<ClubSettings> {
        await atomicWriteJson(this.filePath, settings);
        this.cache = structuredClone(settings);
        return structuredClone(settings);
    }

    getFilePath(): string { return this.filePath; }
}
