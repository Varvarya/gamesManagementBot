import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, backupBeforeMigration, readReliableJson } from '../atomicWrite';

type EntityWithId = {
    id: string;
};

export class BaseJsonRepository<T extends EntityWithId> {
    private cache: T[] = [];
    private isLoaded = false;

    constructor(
        private readonly filePath: string,
        private readonly defaultValue: T[] = [],
    ) {}

    async load(): Promise<void> {
        if (this.isLoaded) return;

        await fs.mkdir(path.dirname(this.filePath), { recursive: true });

        try {
            const loaded = await readReliableJson(this.filePath, (value): value is T[] => Array.isArray(value) && value.every((item) => Boolean(item && typeof item === 'object' && typeof (item as T).id === 'string')));
            this.cache = loaded.data;
            if (loaded.migrated) {
                await backupBeforeMigration(this.filePath, loaded.schemaVersion);
                await this.saveAll();
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === 'ENOENT') {
                this.cache = [...this.defaultValue];
                await this.saveAll();
            } else throw error;
        }

        this.isLoaded = true;
    }

    async list(): Promise<T[]> {
        await this.load();
        return structuredClone(this.cache);
    }

    async findById(id: string): Promise<T | undefined> {
        await this.load();
        const found = this.cache.find((item) => item.id === id);
        return found ? structuredClone(found) : undefined;
    }

    async save(entity: T): Promise<T> {
        await this.load();

        const next = structuredClone(this.cache);
        const saved = structuredClone(entity);
        const index = next.findIndex((item) => item.id === entity.id);

        if (index === -1) {
            next.push(saved);
        } else {
            next[index] = saved;
        }

        await this.saveAll(next);

        return structuredClone(saved);
    }

    async delete(id: string): Promise<void> {
        await this.load();

        await this.saveAll(this.cache.filter((item) => item.id !== id));
    }

    async saveAll(items?: T[]): Promise<void> {
        const next = structuredClone(items ?? this.cache);
        // Commit the in-memory view only after the durable write succeeds. This
        // keeps a failed disk write from looking successful to later requests.
        await atomicWriteJson(this.filePath, next);
        this.cache = next;
    }
}
