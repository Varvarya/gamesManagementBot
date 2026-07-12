import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubSettings } from '../../domain/settings/settings.types';
import { atomicWriteJson } from '../atomicWrite';

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
            const raw = await fs.readFile(this.filePath, 'utf-8');
            this.cache = JSON.parse(raw) as ClubSettings;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === 'ENOENT') {
                this.cache = this.defaultValue;
                await this.save(this.cache);
            } else {
                const backupPath = `${this.filePath}.corrupted-${Date.now()}`;
                await fs.rename(this.filePath, backupPath);
                this.cache = this.defaultValue;
                await this.save(this.cache);
            }
        }

        return this.cache;
    }

    async get(): Promise<ClubSettings> {
        return this.load();
    }

    async save(settings: ClubSettings): Promise<ClubSettings> {
        this.cache = settings;
        await atomicWriteJson(this.filePath, settings);

        return settings;
    }
}