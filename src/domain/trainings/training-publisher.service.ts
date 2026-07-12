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

    async publishFromTemplate(
        template: TrainingTemplate,
        trainingDate: string,
    ): Promise<Training> {
        const existing =
            await this.repositories.trainings.findByTemplateAndDate(
                template.id,
                trainingDate,
            );

        if (existing) {
            return existing;
        }

        const training = await this.trainings.createDraft({
            clubId: template.clubId,
            templateId: template.id,
            chatId: template.chatId,
            title: template.title,
            location: template.location,
            date: trainingDate,
            startTime: template.startTime,
            endTime: template.endTime,
            placesLimit: template.placesLimit,
            minPlayers: template.minPlayers,
        });

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

        return this.trainings.publish({
            trainingId: training.id,
            messageId: message.message_id,
        });
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
}