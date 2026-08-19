import { JsonStorage } from '../../storage/jsonStorage';

export type ProcessedRegistrationMessage = {
    id: string;
    chatId: number;
    messageId: number;
    trainingId?: string;
    status: 'processed' | 'pending_ambiguity';
    processedAt: string;
};

export class ProcessedRegistrationMessageStore {
    private queue: Promise<void> = Promise.resolve();
    private readonly storageKey = 'processed-registration-messages';

    constructor(private readonly storage: JsonStorage, private readonly retentionMs = 30 * 24 * 60 * 60_000) {}

    async processOnce<T>(
        chatId: number,
        messageId: number,
        action: () => Promise<{ value: T; trainingId?: string; status?: ProcessedRegistrationMessage['status'] }>,
    ): Promise<{ duplicate: true } | { duplicate: false; value: T }> {
        return this.serial(async () => {
            const values = await this.readPruned();
            if (values.some((item) => item.chatId === chatId && item.messageId === messageId)) return { duplicate: true as const };
            const result = await action();
            const marker: ProcessedRegistrationMessage = {
                id: `${chatId}:${messageId}`, chatId, messageId, trainingId: result.trainingId,
                status: result.status ?? 'processed', processedAt: new Date().toISOString(),
            };
            await this.storage.write(this.storageKey, [...values, marker]);
            return { duplicate: false as const, value: result.value };
        });
    }

    async has(chatId: number, messageId: number): Promise<boolean> {
        return (await this.readPruned()).some((item) => item.chatId === chatId && item.messageId === messageId);
    }

    private async readPruned(): Promise<ProcessedRegistrationMessage[]> {
        const values = await this.storage.read<ProcessedRegistrationMessage[]>(this.storageKey, []);
        const cutoff = Date.now() - this.retentionMs;
        return values.filter((item) => Date.parse(item.processedAt) >= cutoff);
    }

    private async serial<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.queue;
        let release!: () => void;
        this.queue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await action(); } finally { release(); }
    }
}
