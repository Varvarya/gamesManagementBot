import { RepositoriesContext } from '../../app/repositories.context';
import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
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
};

type PublishTrainingInput = {
    trainingId: string;
    messageId: number;
};

export class TrainingService {
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
    }): Promise<Training | undefined> {
        if (input.replyToMessageId) {
            const training =
                await this.repositories.trainings.findByMessageId(
                    input.chatId,
                    input.replyToMessageId,
                );

            console.log('Resolve training by reply:', {
                chatId: input.chatId,
                replyToMessageId: input.replyToMessageId,
                trainingId: training?.id,
                status: training?.status,
            });

            return training;
        }

        const openTrainings =
            await this.repositories.trainings.listOpenByChatId(
                input.chatId,
            );

        console.log('Resolve training without reply:', {
            chatId: input.chatId,
            openTrainings: openTrainings.map((training: Training) => ({
                id: training.id,
                messageId: training.messageId,
                date: training.date,
                startTime: training.startTime,
                status: training.status,
            })),
        });

        return openTrainings.length === 1
            ? openTrainings[0]
            : undefined;
    }

    async updateStatus(
        trainingId: string,
        status: TrainingStatus,
    ): Promise<Training> {
        const training = await this.getRequired(trainingId);

        training.status = status;
        training.updatedAt = nowIso();

        return this.repositories.trainings.save(training);
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

        return this.repositories.trainings.save(training);
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

        return this.repositories.trainings.save(training);
    }

    async save(training: Training): Promise<Training> {
        training.updatedAt = nowIso();

        return this.repositories.trainings.save(training);
    }

    async getRequired(trainingId: string): Promise<Training> {
        const training = await this.repositories.trainings.findById(trainingId);

        if (!training) {
            throw new Error(`Training ${trainingId} not found`);
        }

        return training;
    }
}