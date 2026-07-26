import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

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
            const content = await readFile(
                this.filePath,
                'utf8',
            );

            const parsed: unknown = JSON.parse(
                content,
            );

            if (!this.isChatsRecord(parsed)) {
                throw new Error(
                    `Invalid chats repository data: ${this.filePath}`,
                );
            }

            this.chats = parsed;
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

    private async save(): Promise<void> {
        await mkdir(
            dirname(
                this.filePath,
            ),
            {
                recursive: true,
            },
        );

        await writeFile(
            this.filePath,
            JSON.stringify(
                this.chats,
                null,
                2,
            ),
            'utf8',
        );
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