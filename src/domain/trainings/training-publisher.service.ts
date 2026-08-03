import { Telegram } from 'telegraf';
import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingTemplate } from '../templates/template.types';
import { TrainingMessageRenderer } from './training-message.renderer';
import { TrainingService } from './training.service';
import { Training } from './training.types';
import { logger } from '../../utils/logger';
import { isTelegramMessageNotModified, isTelegramMessageUnavailable } from '../../utils/telegramEditErrors';

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
    cancelCheckHoursBefore?: number;
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
    cancelCheckHoursBefore?: number;
};

export class TrainingPublisherService {
    private readonly templatePublications =
        new Map<string, Promise<Training>>();
    private readonly renderedMessages = new Map<string, string>();
    private readonly refreshes = new Map<string, {
        requested: boolean;
        promise: Promise<boolean>;
    }>();
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

    async refreshMessage(trainingId: string): Promise<boolean> {
        const current = this.refreshes.get(trainingId);
        if (current) {
            current.requested = true;
            return current.promise;
        }

        const state = { requested: false, promise: Promise.resolve(false) };
        state.promise = this.runRefreshLoop(trainingId, state);
        this.refreshes.set(trainingId, state);
        try {
            return await state.promise;
        } finally {
            if (this.refreshes.get(trainingId) === state) this.refreshes.delete(trainingId);
        }
    }

    private async runRefreshLoop(
        trainingId: string,
        state: { requested: boolean },
    ): Promise<boolean> {
        let edited = false;
        do {
            state.requested = false;
            edited = await this.refreshMessageOnce(trainingId) || edited;
        } while (state.requested);
        return edited;
    }

    private async refreshMessageOnce(trainingId: string): Promise<boolean> {
        const training = await this.trainings.getRequired(trainingId);

        if (!training.messageId) {
            logger.warn('publication.message_missing', { trainingId: training.id });
            return false;
        }

        const text = await this.render(training);
        if (this.renderedMessages.get(training.id) === text) return false;

        try {
            await this.telegram.editMessageText(
                training.chatId,
                training.messageId,
                undefined,
                text,
            );
            this.renderedMessages.set(training.id, text);
            logger.info('publication.message_updated', { trainingId: training.id, chatId: training.chatId, messageId: training.messageId });
            return true;
        } catch (error) {
            if (isTelegramMessageNotModified(error)) {
                this.renderedMessages.set(training.id, text);
                return false;
            }
            if (isTelegramMessageUnavailable(error)) {
                logger.warn('publication.message_unavailable', { trainingId: training.id, chatId: training.chatId, messageId: training.messageId });
                return false;
            }

            logger.error('publication.message_update_failed', { trainingId: training.id, chatId: training.chatId, messageId: training.messageId, error });
            return false;
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

        let message: Awaited<ReturnType<Telegram['sendMessage']>>;

        try {
            message = await this.telegram.sendMessage(
                training.chatId,
                text,
            );
        } catch (error) {
            logger.error('publication.send_failed', { trainingId: training.id, chatId: training.chatId, error });
            throw new Error(
                `Failed to publish training ${training.id} to chat ${training.chatId}`,
                { cause: error },
            );
        }

        let published: Training;

        try {
            published = await this.trainings.publish({
                trainingId: training.id,
                messageId: message.message_id,
            });
        } catch (error) {
            try {
                await this.telegram.deleteMessage(
                    training.chatId,
                    message.message_id,
                );
            } catch (rollbackError) {
                logger.error('publication.rollback_failed', { trainingId: training.id, chatId: training.chatId, messageId: message.message_id, error: rollbackError });
            }

            throw new Error(
                `Failed to persist Telegram publication for training ${training.id}`,
                { cause: error },
            );
        }

        this.renderedMessages.set(published.id, text);
        logger.info('publication.published', { trainingId: published.id, chatId: published.chatId, messageId: published.messageId, templateId: published.templateId, slotId: published.templateSlotId });

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

    async notifyCancellation(trainingId: string): Promise<void> {
        const training = await this.trainings.getRequired(trainingId);
        try {
            await this.telegram.sendMessage(training.chatId, `❌ ${training.title} ${training.date} о ${training.startTime} скасовано: недостатньо зареєстрованих гравців.`);
        } catch (error) {
            logger.error('publication.cancellation_notification_failed', { trainingId: training.id, chatId: training.chatId, error });
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
        const key = [
            input.templateId,
            input.slotId,
            input.date,
        ].join(':');

        const inFlight =
            this.templatePublications.get(key);

        if (inFlight) {
            return inFlight;
        }

        const publication =
            this.publishTemplateSlotOnce(input);

        this.templatePublications.set(
            key,
            publication,
        );

        try {
            return await publication;
        } finally {
            this.templatePublications.delete(key);
        }
    }

    private async publishTemplateSlotOnce(
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
            logger.info('publication.duplicate_skipped', { trainingId: existing.id, templateId: input.templateId, slotId: input.slotId, date: input.date });
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

                cancelCheckHoursBefore: input.cancelCheckHoursBefore,
            });

        return this.publishDraft(
            training,
        );
    }
}
