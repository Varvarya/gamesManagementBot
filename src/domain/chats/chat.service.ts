import {
    ChatsRepository,
} from '../../storage/repositories/chats.repository';

import {
    ChatConfig,
    CreateChatInput,
    UpdateChatInput,
} from './chat.types';
import { logger } from '../../utils/logger';

export class ChatService {
    constructor(
        private readonly repository: ChatsRepository,
    ) {}

    async getAll(): Promise<ChatConfig[]> {
        const chats =
            await this.repository.getAll();

        return chats.sort(
            (left, right) =>
                left.name.localeCompare(
                    right.name,
                    'uk',
                ),
        );
    }

    async getEnabled(): Promise<ChatConfig[]> {
        const chats =
            await this.repository.getEnabled();

        return chats.sort(
            (left, right) =>
                left.name.localeCompare(
                    right.name,
                    'uk',
                ),
        );
    }

    async getById(
        id: number,
    ): Promise<ChatConfig | undefined> {
        return this.repository.getById(
            id,
        );
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
        this.validateInput(input);

        const chat = await this.repository.create(input);
        logger.info('chat.created', { chatId: chat.id, enabled: chat.enabled });
        return chat;
    }

    async update(
        id: number,
        input: UpdateChatInput,
    ): Promise<ChatConfig> {
        if (
            input.name !== undefined &&
            !input.name.trim()
        ) {
            throw new Error(
                'Chat name cannot be empty',
            );
        }

        const chat = await this.repository.update(id, input);
        logger.info('chat.updated', { chatId: id, changedFields: Object.keys(input) });
        return chat;
    }

    async upsert(
        input: CreateChatInput,
    ): Promise<ChatConfig> {
        this.validateInput(input);

        const chat = await this.repository.upsert(input);
        logger.info('chat.upserted', { chatId: chat.id, enabled: chat.enabled });
        return chat;
    }

    async toggle(
        id: number,
    ): Promise<ChatConfig> {
        const chat =
            await this.getRequired(id);

        const updated = await this.repository.update(
            id,
            {
                enabled:
                    !chat.enabled,
            },
        );
        logger.info('chat.toggled', { chatId: id, enabled: updated.enabled });
        return updated;
    }

    async delete(
        id: number,
    ): Promise<void> {
        await this.repository.delete(
            id,
        );
        logger.info('chat.deleted', { chatId: id });
    }

    private validateInput(
        input: CreateChatInput,
    ): void {
        if (
            !Number.isSafeInteger(
                input.id,
            )
        ) {
            throw new Error(
                'Invalid Telegram chat id',
            );
        }

        if (!input.name.trim()) {
            throw new Error(
                'Chat name cannot be empty',
            );
        }
    }
}
