import { Telegram } from 'telegraf';
import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingTemplate } from '../templates/template.types';
import { TrainingMessageRenderer } from './training-message.renderer';
import { TrainingService } from './training.service';
import { Training } from './training.types';
import { logger } from '../../utils/logger';
import { isTelegramMessageNotModified, isTelegramMessageUnavailable } from '../../utils/telegramEditErrors';
import { PublicationTrace, publicationTraceFields } from './publication-trace';

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
    trace?: PublicationTrace;
};

export class TrainingPublisherService {
    private readonly templatePublications =
        new Map<string, Promise<Training>>();
    private readonly draftPublications = new Map<string, Promise<Training>>();
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
        trace: PublicationTrace = { triggerSource: 'manual_admin' },
    ): Promise<Training> {
        const training = await this.trainings.createDraft(input);
        logger.info('scheduler.training_resolved', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, result: 'created', date: training.date });

        return this.publishDraft(training, trace);
    }

    async publishExistingDraft(trainingId: string, trace?: PublicationTrace): Promise<Training> {
        const current = this.draftPublications.get(trainingId);
        if (current) return current;
        const publication = this.publishExistingDraftOnce(trainingId, trace);
        this.draftPublications.set(trainingId, publication);
        try { return await publication; }
        finally { if (this.draftPublications.get(trainingId) === publication) this.draftPublications.delete(trainingId); }
    }

    private async publishExistingDraftOnce(trainingId: string, trace?: PublicationTrace): Promise<Training> {
        const training = await this.trainings.getRequired(trainingId);
        logger.info('scheduler.training_resolved', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, result: 'existing', templateId: training.templateId, slotId: training.templateSlotId, date: training.date, status: training.status });
        if (training.status !== 'draft') {
            logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, reason: 'already_published' });
            return training;
        }
        return this.publishDraft(training, trace);
    }

    async republish(trainingId: string): Promise<Training> {
        const training = await this.trainings.getRequired(trainingId);
        if (training.status === 'draft') return this.publishExistingDraft(trainingId);
        if (!training.publicationStale && training.messageId) throw new Error('Publication is still active');
        training.messageId = undefined;
        training.status = 'draft';
        training.publicationStale = false;
        await this.repositories.trainings.save(training);
        return this.publishExistingDraft(training.id);
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
                training.publicationStale = true;
                training.updatedAt = new Date().toISOString();
                await this.repositories.trainings.save(training);
                logger.warn('publication.message_unavailable', { trainingId: training.id, chatId: training.chatId, messageId: training.messageId });
                return false;
            }

            logger.error('publication.message_update_failed', { trainingId: training.id, chatId: training.chatId, messageId: training.messageId, error });
            return false;
        }
    }

    private async publishDraft(
        training: Training,
        trace?: PublicationTrace,
    ): Promise<Training> {
        if (training.messageId) {
            throw new Error(
                `Training ${training.id} is already published`,
            );
        }

        let text: string;
        try {
            logger.info('training_publication.render_started', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, templateId: training.templateId, slotId: training.templateSlotId });
            text = await this.render({ ...training, status: 'open' });
            logger.info('training_publication.render_succeeded', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, templateId: training.templateId, slotId: training.templateSlotId });
        } catch (error) {
            logger.error('training_publication.render_failed', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, templateId: training.templateId, slotId: training.templateSlotId, error });
            throw error;
        }

        let message: Awaited<ReturnType<Telegram['sendMessage']>>;

        try {
            logger.info('training_publication.telegram_send_started', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, templateId: training.templateId, slotId: training.templateSlotId, chatId: training.chatId });
            message = await this.telegram.sendMessage(
                training.chatId,
                text,
            );
        } catch (error) {
            logger.error('training_publication.telegram_send_failed', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, templateId: training.templateId, slotId: training.templateSlotId, chatId: training.chatId, error });
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
            logger.error('training_publication.persistence_failed', { ...publicationTraceFields(trace), clubId: training.clubId, trainingId: training.id, templateId: training.templateId, slotId: training.templateSlotId, chatId: training.chatId, messageId: message.message_id, error });
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
        logger.info('training_publication.persistence_succeeded', { ...publicationTraceFields(trace), clubId: published.clubId, trainingId: published.id, templateId: published.templateId, slotId: published.templateSlotId, chatId: published.chatId, messageId: published.messageId });
        logger.info('training_publication.telegram_send_succeeded', { ...publicationTraceFields(trace), clubId: published.clubId, trainingId: published.id, templateId: published.templateId, slotId: published.templateSlotId, chatId: published.chatId, messageId: published.messageId });
        logger.info('training_publication.completed', { ...publicationTraceFields(trace), clubId: published.clubId, trainingId: published.id, templateId: published.templateId, slotId: published.templateSlotId, chatId: published.chatId, messageId: published.messageId });
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
            if (existing.status === 'draft' && !existing.messageId) {
                logger.info('scheduler.training_resolved', { ...publicationTraceFields(input.trace), trainingId: existing.id, clubId: existing.clubId, result: 'existing', templateId: input.templateId, slotId: input.slotId, date: input.date, status: existing.status });
                return this.publishDraft(existing, input.trace);
            }
            logger.info('scheduler.training_resolved', { ...publicationTraceFields(input.trace), trainingId: existing.id, clubId: existing.clubId, result: 'existing', templateId: input.templateId, slotId: input.slotId, date: input.date, status: existing.status });
            logger.info('scheduler.job_skipped', { ...publicationTraceFields(input.trace), clubId: existing.clubId, trainingId: existing.id, templateId: input.templateId, slotId: input.slotId, date: input.date, reason: 'already_published' });
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

        logger.info('scheduler.training_resolved', { ...publicationTraceFields(input.trace), trainingId: training.id, clubId: input.clubId, result: 'created', templateId: input.templateId, slotId: input.slotId, date: input.date });

        return this.publishDraft(
            training,
            input.trace,
        );
    }
}
