import { RepositoriesContext } from '../../app/repositories.context';
import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import { logger } from '../../utils/logger';
import { Training, TrainingStatus } from './training.types';

type CreateTrainingInput = {
    clubId: string;
    chatId: number;
    templateId?: string;
    templateSlotId?: string;
    title: string;
    location?: string;
    date: string;
    startTime: string;
    endTime: string;
    placesLimit: number;
    minPlayers: number;
    cancelCheckHoursBefore?: number;
};

type PublishTrainingInput = {
    trainingId: string;
    messageId: number;
};

export class TrainingService {
    private onChanged?: (training: Training) => Promise<void>;

    constructor(
        private readonly repositories: RepositoriesContext,
    ) {}

    async createDraft(input: CreateTrainingInput): Promise<Training> {
        const now = nowIso();

        const training: Training = {
            id: createId('training'),
            clubId: input.clubId,
            templateId: input.templateId,
            templateSlotId: input.templateSlotId,
            chatId: input.chatId,
            title: input.title,
            location: input.location,
            date: input.date,
            startTime: input.startTime,
            endTime: input.endTime,
            placesLimit: input.placesLimit,
            minPlayers: input.minPlayers,
            cancelCheckHoursBefore: input.cancelCheckHoursBefore ?? 4,
            status: 'draft',
            participants: [],
            waitlist: [],
            createdAt: now,
            updatedAt: now,
        };

        return this.repositories.trainings.save(training);
    }

    async publish(input: PublishTrainingInput): Promise<Training> {
        const training = await this.getRequired(input.trainingId);
        const now = nowIso();

        training.messageId = input.messageId;
        training.status = 'open';
        training.publishedAt = now;
        training.updatedAt = now;

        return this.repositories.trainings.save(training);
    }

    async findByMessageId(
        chatId: number,
        messageId: number,
    ): Promise<Training | undefined> {
        return this.repositories.trainings.findByMessageId(chatId, messageId);
    }

    async resolveTargetTraining(input: {
        chatId: number;
        replyToMessageId?: number;
        date?: string;
        startTime?: string;
    }): Promise<Training | undefined> {
        if (input.replyToMessageId) {
            const training =
                await this.repositories.trainings.findByMessageId(
                    input.chatId,
                    input.replyToMessageId,
                );

            return training;
        }

        const openTrainings = await this.listRelevantOpenByChatId(input.chatId);

        if (openTrainings.length === 1 && !input.date && !input.startTime) {
            return openTrainings[0];
        }

        if (!input.date && !input.startTime) {
            return undefined;
        }

        const matches = openTrainings.filter((training) =>
            (!input.date || training.date === input.date) &&
            (!input.startTime || training.startTime === input.startTime),
        );

        return matches.length === 1 ? matches[0] : undefined;
    }

    async listRelevantOpenByChatId(chatId: number): Promise<Training[]> {
        const now = new Date();
        const today = kyivDate(now);
        const currentTime = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(now);
        return (await this.repositories.trainings.listOpenByChatId(chatId))
            .filter((training) => training.messageId !== undefined)
            .filter((training) => training.date > today || (training.date === today && training.startTime > currentTime))
            .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    }

    isRelevantOpen(training: Training, chatId: number): boolean {
        if (training.chatId !== chatId || training.status !== 'open' || training.messageId === undefined) return false;
        const now = new Date();
        const today = kyivDate(now);
        const currentTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
        return training.date > today || (training.date === today && training.startTime > currentTime);
    }

    async updateStatus(
        trainingId: string,
        status: TrainingStatus,
    ): Promise<Training> {
        const training = await this.getRequired(trainingId);

        if (training.status === status) return training;
        if (!ALLOWED_TRANSITIONS[training.status].includes(status)) {
            throw new Error(`Invalid training transition: ${training.status} -> ${status}`);
        }

        training.status = status;
        training.updatedAt = nowIso();

        const saved = await this.repositories.trainings.save(training);
        await this.notifyChanged(saved);
        return saved;
    }

    async open(trainingId: string): Promise<Training> {
        return this.updateStatus(trainingId, 'open');
    }

    async close(trainingId: string): Promise<Training> {
        return this.updateStatus(trainingId, 'closed');
    }

    async cancel(trainingId: string): Promise<Training> {
        return this.updateStatus(trainingId, 'cancelled');
    }

    async finish(trainingId: string): Promise<Training> {
        return this.updateStatus(trainingId, 'finished');
    }

    async archive(trainingId: string): Promise<Training> {
        return this.updateStatus(trainingId, 'archived');
    }

    async updatePlacesLimit(
        trainingId: string,
        placesLimit: number,
    ): Promise<Training> {
        if (placesLimit < 1) {
            throw new Error('placesLimit must be greater than 0');
        }

        const training = await this.getRequired(trainingId);

        training.placesLimit = placesLimit;
        training.updatedAt = nowIso();

        const saved = await this.repositories.trainings.save(training);
        await this.notifyChanged(saved);
        return saved;
    }

    async updateMinPlayers(
        trainingId: string,
        minPlayers: number,
    ): Promise<Training> {
        if (minPlayers < 0) {
            throw new Error('minPlayers can not be negative');
        }

        const training = await this.getRequired(trainingId);

        training.minPlayers = minPlayers;
        training.updatedAt = nowIso();

        const saved = await this.repositories.trainings.save(training);
        await this.notifyChanged(saved);
        return saved;
    }

    async save(training: Training): Promise<Training> {
        training.updatedAt = nowIso();
        const saved = await this.repositories.trainings.save(training);
        await this.notifyChanged(saved);
        return saved;
    }

    setOnChanged(callback: (training: Training) => Promise<void>): void {
        this.onChanged = callback;
    }

    private async notifyChanged(training: Training): Promise<void> {
        if (!this.onChanged || !training.messageId) return;
        try {
            await this.onChanged(training);
        } catch (error) {
            logger.error('publication.automatic_refresh_failed', { trainingId: training.id, error });
        }
    }

    async getRequired(trainingId: string): Promise<Training> {
        const training = await this.repositories.trainings.findById(trainingId);

        if (!training) {
            throw new Error(`Training ${trainingId} not found`);
        }

        return training;
    }
}

const ALLOWED_TRANSITIONS: Record<TrainingStatus, readonly TrainingStatus[]> = {
    draft: ['open', 'cancelled'],
    open: ['closed', 'cancelled'],
    closed: ['open', 'finished', 'cancelled'],
    cancelled: ['archived'],
    finished: ['archived'],
    archived: [],
};

function kyivDate(value: Date): string {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
}
