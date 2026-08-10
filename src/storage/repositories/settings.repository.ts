import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubSettings } from '../../domain/settings/settings.types';
import { atomicWriteJson, backupBeforeMigration, readReliableJson } from '../atomicWrite';
import { clubAdminTelegramId, StoredClubAdmin } from '../../domain/settings/club-admin-authorization';

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
            this.cache = normalizeSettings({ ...this.defaultValue, ...loaded.data });
            const defaultsAdded = Object.keys(this.defaultValue).some((key) => !(key in loaded.data));
            const normalized = JSON.stringify(this.cache) !== JSON.stringify({ ...this.defaultValue, ...loaded.data });
            if (loaded.migrated) {
                await backupBeforeMigration(this.filePath, loaded.schemaVersion);
            }
            if (loaded.migrated || defaultsAdded || normalized) await this.save(this.cache);
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

function normalizeSettings(settings: ClubSettings): ClubSettings {
    const raw = settings as ClubSettings & { admins: StoredClubAdmin[] };
    const seen = new Set<number>();
    const admins: ClubSettings['admins'] = [];
    for (const entry of raw.admins) {
        const telegramUserId = clubAdminTelegramId(entry);
        if (!telegramUserId || seen.has(telegramUserId)) continue;
        seen.add(telegramUserId);
        const role = typeof entry === 'object' && entry !== null && 'role' in entry && entry.role === 'owner' ? 'owner' : 'admin';
        admins.push({ telegramUserId, role });
    }
    return {
        ...settings,
        admins,
        createdAt: normalizeTimestamp(settings.createdAt),
        updatedAt: normalizeTimestamp(settings.updatedAt),
    };
}

function normalizeTimestamp(value: string): string {
    if (/^\d+$/.test(value)) {
        const date = new Date(Number(value));
        if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
