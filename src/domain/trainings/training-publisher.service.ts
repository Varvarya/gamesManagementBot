import { Telegram } from 'telegraf';
import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingTemplate } from '../templates/template.types';
import { TrainingMessageRenderer } from './training-message.renderer';
import { TrainingService } from './training.service';
import { Training } from './training.types';

type PublishManualTrainingInput = {
    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    date: string;
    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;
};

export type PublishTemplateSlotInput = {
    templateId: string;
    slotId: string;

    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    date: string;

    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;
};

export class TrainingPublisherService {
    constructor(
        private readonly telegram: Telegram,
        private readonly repositories: RepositoriesContext,
        private readonly trainings: TrainingService,
        private readonly renderer: TrainingMessageRenderer,
    ) {}

    async publishManual(
        input: PublishManualTrainingInput,
    ): Promise<Training> {
        const training = await this.trainings.createDraft(input);

        return this.publishDraft(training);
    }

    async refreshMessage(trainingId: string): Promise<void> {
        const training = await this.trainings.getRequired(trainingId);

        if (!training.messageId) {
            throw new Error(
                `Training ${training.id} has not been published`,
            );
        }

        const text = await this.render(training);

        try {
            await this.telegram.editMessageText(
                training.chatId,
                training.messageId,
                undefined,
                text,
            );
        } catch (error) {
            if (this.isMessageNotModifiedError(error)) {
                return;
            }

            throw error;
        }
    }

    private async publishDraft(
        training: Training,
    ): Promise<Training> {
        if (training.messageId) {
            throw new Error(
                `Training ${training.id} is already published`,
            );
        }

        const text = await this.render({
            ...training,
            status: 'open',
        });

        const message = await this.telegram.sendMessage(
            training.chatId,
            text,
        );

        const published =
            await this.trainings.publish({
                trainingId: training.id,
                messageId: message.message_id,
            });

        if (this.onPublished) {
            await this.onPublished(published);
        }

        return published;
    }

    private async render(training: Training): Promise<string> {
        const players = await this.repositories.players.list();

        return this.renderer.render({
            training,
            players,
        });
    }

    private isMessageNotModifiedError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }

        return error.message.includes(
            'message is not modified',
        );
    }

    async refreshMessagesForPlayer(
        playerId: string,
    ): Promise<void> {
        const trainings =
            await this.repositories.trainings.listActive();

        const relatedTrainings = trainings.filter(
            (training: Training) =>
                training.participants.some(
                    (participant) =>
                        participant.playerId === playerId,
                ) ||
                training.waitlist.some(
                    (participant) =>
                        participant.playerId === playerId,
                ),
        );

        for (const training of relatedTrainings) {
            if (!training.messageId) {
                continue;
            }

            await this.refreshMessage(training.id);
        }
    }

    private onPublished?: (
        training: Training,
    ) => Promise<void>;

    setOnPublished(
        callback: (
            training: Training,
        ) => Promise<void>,
    ): void {
        this.onPublished = callback;
    }

    async publishTemplateSlot(
        input: PublishTemplateSlotInput,
    ): Promise<Training> {
        const existing =
            await this.repositories.trainings.findByTemplateSlotAndDate({
                templateId:
                input.templateId,

                templateSlotId:
                input.slotId,

                date:
                input.date,
            });

        /*
         * Захист від дублювання після:
         * - перезапуску;
         * - ручного sync;
         * - повторного спрацювання job.
         */
        if (existing) {
            return existing;
        }

        const training =
            await this.trainings.createDraft({
                clubId:
                input.clubId,

                chatId:
                input.chatId,

                templateId:
                input.templateId,

                templateSlotId: input.slotId,

                title:
                input.title,

                location:
                input.location,

                date:
                input.date,

                startTime:
                input.startTime,

                endTime:
                input.endTime,

                placesLimit:
                input.placesLimit,

                minPlayers:
                input.minPlayers,
            });

        return this.publishDraft(
            training,
        );
    }
}