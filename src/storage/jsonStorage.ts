import {
    mkdir,
} from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, backupBeforeMigration, readReliableJson } from './atomicWrite';

export type JsonStorageOptions = {
    dataDir: string;
    storageSlug?: string;
    /** @deprecated use storageSlug */
    clubId?: string;
};

export class JsonStorage {
    private readonly directoryPath: string;

    constructor(
        options: JsonStorageOptions,
    ) {
        this.directoryPath = path.resolve(
            options.dataDir,
            this.sanitizePathPart(
                options.storageSlug ?? options.clubId ?? 'club',
            ),
        );
    }

    async read<T>(
        storageKey: string,
        fallback: T,
    ): Promise<T> {
        const filePath =
            this.resolveFilePath(
                storageKey,
            );

        try {
            const loaded = await readReliableJson(filePath, (value): value is T => value !== undefined);
            if (loaded.migrated) {
                await backupBeforeMigration(filePath, loaded.schemaVersion);
                await atomicWriteJson(filePath, loaded.data);
            }
            return loaded.data;
        } catch (error) {
            if (
                this.isNodeError(
                    error,
                ) &&
                error.code === 'ENOENT'
            ) {
                return this.clone(
                    fallback,
                );
            }

            throw error;
        }
    }

    async write<T>(
        storageKey: string,
        value: T,
    ): Promise<void> {
        const filePath =
            this.resolveFilePath(
                storageKey,
            );

        try {
            await atomicWriteJson(filePath, value);
        } catch (error) {
            throw new Error(
                `Failed to write JSON storage file ${filePath}`,
                {
                    cause: error,
                },
            );
        }
    }

    async update<T>(
        storageKey: string,
        fallback: T,
        updater: (
            current: T,
        ) => T | Promise<T>,
    ): Promise<T> {
        const current =
            await this.read(
                storageKey,
                fallback,
            );

        const updated =
            await updater(
                current,
            );

        await this.write(
            storageKey,
            updated,
        );

        return updated;
    }

    getFilePath(
        storageKey: string,
    ): string {
        return this.resolveFilePath(
            storageKey,
        );
    }

    getDirectoryPath(): string {
        return this.directoryPath;
    }

    async ensureReady(): Promise<void> {
        await this.ensureDirectory();
    }

    private async ensureDirectory(): Promise<void> {
        await mkdir(
            this.directoryPath,
            {
                recursive: true,
            },
        );
    }

    private resolveFilePath(
        storageKey: string,
    ): string {
        const normalizedKey =
            storageKey.endsWith(
                '.json',
            )
                ? storageKey
                : `${storageKey}.json`;

        const fileName =
            this.sanitizeFileName(
                normalizedKey,
            );

        return path.join(
            this.directoryPath,
            fileName,
        );
    }

    private sanitizeFileName(
        value: string,
    ): string {
        const baseName =
            path.basename(value);

        if (
            baseName !== value ||
            baseName === '.' ||
            baseName === '..'
        ) {
            throw new Error(
                `Invalid storage key: ${value}`,
            );
        }

        if (
            !/^[a-zA-Z0-9._-]+$/.test(
                baseName,
            )
        ) {
            throw new Error(
                `Storage key contains unsupported characters: ${value}`,
            );
        }

        return baseName;
    }

    private sanitizePathPart(
        value: string,
    ): string {
        const normalized =
            value
                .trim()
                .replace(
                    /[^a-zA-Z0-9._-]+/g,
                    '_',
                );

        if (
            !normalized ||
            normalized === '.' ||
            normalized === '..'
        ) {
            throw new Error(
                `Invalid clubId: ${value}`,
            );
        }

        return normalized;
    }

    private clone<T>(
        value: T,
    ): T {
        if (
            value === undefined ||
            value === null
        ) {
            return value;
        }

        return structuredClone(
            value,
        );
    }

    private isNodeError(
        error: unknown,
    ): error is NodeJS.ErrnoException {
        return (
            error instanceof Error &&
            'code' in error
        );
    }
}
