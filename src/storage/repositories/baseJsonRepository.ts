import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../atomicWrite';

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
            const raw = await fs.readFile(this.filePath, 'utf-8');
            this.cache = JSON.parse(raw) as T[];
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === 'ENOENT') {
                this.cache = [...this.defaultValue];
                await this.saveAll();
            } else {
                const backupPath = `${this.filePath}.corrupted-${Date.now()}`;
                await fs.rename(this.filePath, backupPath);
                this.cache = [...this.defaultValue];
                await this.saveAll();
            }
        }

        this.isLoaded = true;
    }

    async list(): Promise<T[]> {
        await this.load();
        return [...this.cache];
    }

    async findById(id: string): Promise<T | undefined> {
        await this.load();
        return this.cache.find((item) => item.id === id);
    }

    async save(entity: T): Promise<T> {
        await this.load();

        const index = this.cache.findIndex((item) => item.id === entity.id);

        if (index === -1) {
            this.cache.push(entity);
        } else {
            this.cache[index] = entity;
        }

        await this.saveAll();

        return entity;
    }

    async delete(id: string): Promise<void> {
        await this.load();

        this.cache = this.cache.filter((item) => item.id !== id);

        await this.saveAll();
    }

    async saveAll(items?: T[]): Promise<void> {
        if (items) {
            this.cache = [...items];
        }

        await atomicWriteJson(this.filePath, this.cache);
    }
}