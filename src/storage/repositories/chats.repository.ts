import {
    mkdir,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteJson, backupBeforeMigration, readReliableJson } from '../atomicWrite';

import {
    ChatConfig,
    CreateChatInput,
    UpdateChatInput,
} from '../../domain/chats/chat.types';

export class ChatsRepository {
    private chats: Record<string, ChatConfig> = {};

    constructor(
        private readonly filePath: string,
    ) {}

    async load(): Promise<void> {
        try {
            const loaded = await readReliableJson(this.filePath, (value): value is unknown => Boolean(value && typeof value === 'object'));
            this.chats = this.migrateChats(loaded.data);
            if (loaded.migrated || !this.isChatsRecord(loaded.data)) {
                await backupBeforeMigration(this.filePath, loaded.schemaVersion);
                await this.save();
            }
        } catch (error) {
            if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'ENOENT'
            ) {
                this.chats = {};

                await this.save();

                return;
            }

            throw error;
        }
    }

    async getAll(): Promise<ChatConfig[]> {
        return Object.values(
            this.chats,
        );
    }

    async getEnabled(): Promise<ChatConfig[]> {
        return Object.values(
            this.chats,
        ).filter(
            chat => chat.enabled,
        );
    }

    async getById(
        id: number,
    ): Promise<ChatConfig | undefined> {
        return this.chats[
            String(id)
            ];
    }

    async getRequired(
        id: number,
    ): Promise<ChatConfig> {
        const chat =
            await this.getById(id);

        if (!chat) {
            throw new Error(
                `Chat not found: ${id}`,
            );
        }

        return chat;
    }

    async create(
        input: CreateChatInput,
    ): Promise<ChatConfig> {
        const key =
            String(input.id);

        if (this.chats[key]) {
            throw new Error(
                `Chat already exists: ${input.id}`,
            );
        }

        const chat: ChatConfig = {
            ...input,
            id: input.id,
            name: input.name.trim(),
            enabled:
                input.enabled ?? true,
        };

        this.chats[key] =
            chat;

        await this.save();

        return chat;
    }

    async update(
        id: number,
        input: UpdateChatInput,
    ): Promise<ChatConfig> {
        const key =
            String(id);

        const existing =
            this.chats[key];

        if (!existing) {
            throw new Error(
                `Chat not found: ${id}`,
            );
        }

        const updated: ChatConfig = {
            ...existing,
            ...input,

            name:
                input.name !== undefined
                    ? input.name.trim()
                    : existing.name,

            enabled:
                input.enabled ??
                existing.enabled,
        };

        this.chats[key] =
            updated;

        await this.save();

        return updated;
    }

    async upsert(
        input: CreateChatInput,
    ): Promise<ChatConfig> {
        const key =
            String(input.id);

        const existing =
            this.chats[key];

        const chat: ChatConfig = {
            ...existing,
            ...input,
            id: input.id,
            name: input.name.trim(),

            enabled:
                input.enabled ??
                existing?.enabled ??
                true,
        };

        this.chats[key] =
            chat;

        await this.save();

        return chat;
    }

    async delete(
        id: number,
    ): Promise<void> {
        const key =
            String(id);

        if (!this.chats[key]) {
            return;
        }

        delete this.chats[key];

        await this.save();
    }

    async replaceAll(chats: ChatConfig[]): Promise<void> {
        this.chats = Object.fromEntries(chats.map((chat) => [String(chat.id), { ...chat }]));
        await this.save();
    }

    private async save(): Promise<void> {
        await mkdir(
            dirname(
                this.filePath,
            ),
            {
                recursive: true,
            },
        );

        await atomicWriteJson(this.filePath, this.chats);
    }

    private isChatsRecord(
        value: unknown,
    ): value is Record<
        string,
        ChatConfig
    > {
        if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
        ) {
            return false;
        }

        return Object.entries(
            value,
        ).every(
            ([key, chat]) =>
                this.isChatConfig(
                    key,
                    chat,
                ),
        );
    }

    private migrateChats(value: unknown): Record<string, ChatConfig> {
        const candidates = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
        const result: Record<string, ChatConfig> = {};
        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object') throw new Error('Invalid chat entry; migration refused to discard it');
            const record = candidate as Record<string, unknown>;
            const nested = record.gameChat ?? record.chat;
            const source = nested && typeof nested === 'object' ? { ...record, ...(nested as Record<string, unknown>) } : record;
            const id = source.id ?? record.chatId ?? (typeof nested === 'number' ? nested : undefined);
            if (!Number.isSafeInteger(id)) throw new Error('Chat entry has no valid id');
            const chat: ChatConfig = { id: id as number, name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `Chat ${id}`, enabled: source.enabled !== false };
            result[String(chat.id)] = chat;
        }
        return result;
    }

    private isChatConfig(
        key: string,
        value: unknown,
    ): value is ChatConfig {
        if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
        ) {
            return false;
        }

        if (
            !('id' in value) ||
            !Number.isSafeInteger(
                value.id,
            )
        ) {
            return false;
        }

        if (
            String(value.id) !== key
        ) {
            return false;
        }

        if (
            !('name' in value) ||
            typeof value.name !==
            'string'
        ) {
            return false;
        }

        if (
            !('enabled' in value) ||
            typeof value.enabled !==
            'boolean'
        ) {
            return false;
        }

        return true;
    }
}
