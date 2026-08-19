import { ServicesContext } from '../../app/services.context';
import { logger } from '../../utils/logger';
import { TelegramUserConnectionManager, TelegramHistoryMessage } from '../telegram-import/telegram-user-connection.manager';
import { registrationCommandParser, RegistrationCommandParseError } from './registration-command.parser';
import { ProcessedRegistrationMessageStore } from './processed-registration-message.store';
import { TrainingPublisherService } from './training-publisher.service';
import { Training } from './training.types';
import { RegistrationReviewService, registrationReviewRecipients } from './registration-review.service';

export class RegistrationRecoveryService {
    constructor(
        private readonly clubId: string,
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
        private readonly connections: Pick<TelegramUserConnectionManager, 'readRecentMessages'>,
        private readonly processed: ProcessedRegistrationMessageStore,
        private readonly reviews?: RegistrationReviewService,
        private readonly historyLimit = 200,
    ) {}

    async recoverActive(): Promise<void> {
        const trainings = (await this.services.repositories.trainings.list()).filter((item) => item.status === 'open' && item.publishedAt && item.messageId);
        for (const training of trainings) await this.recoverTraining(training);
    }

    async recoverTraining(training: Training): Promise<void> {
        const openedAt = training.publishedAt ?? training.createdAt;
        const fields = { clubId: this.clubId, trainingId: training.id, chatId: training.chatId };
        logger.info('registration.recovery_started', fields);
        let messages: TelegramHistoryMessage[];
        try {
            messages = await this.connections.readRecentMessages(this.clubId, training.chatId, new Date(openedAt), this.historyLimit);
        } catch (error) {
            const unavailable = error instanceof Error && ['TELEGRAM_RECOVERY_SOURCE_UNAVAILABLE', 'TELEGRAM_IMPORT_SOURCE_UNAVAILABLE'].includes(error.message);
            logger[unavailable ? 'warn' : 'error'](unavailable ? 'registration.recovery_unavailable' : 'registration.recovery_failed', { ...fields, error });
            return;
        }
        let processedCount = 0; let skippedAlreadyProcessed = 0; let invalidCount = 0; let ambiguousCount = 0;
        for (const message of messages.sort((a, b) => a.date.getTime() - b.date.getTime() || a.messageId - b.messageId)) {
            let command;
            try { command = registrationCommandParser.parse(message.text); }
            catch (error) { if (error instanceof RegistrationCommandParseError) invalidCount++; continue; }
            if (!command) { invalidCount++; continue; }
            try {
                const result = await this.processed.processOnce<{ kind: 'ambiguous' } | { kind: 'processed'; trainingId: string }>(training.chatId, message.messageId, async () => {
                    const input = { telegramUser: message.telegramUser, chatId: training.chatId, command };
                    const resolution = await this.services.registration.resolveCommand(input);
                    if (resolution.kind === 'none') throw new Error(resolution.reason);
                    if (resolution.kind === 'suspicious') {
                        if (!this.reviews) throw new Error('REGISTRATION_REVIEW_UNAVAILABLE');
                        const settings = await this.services.repositories.settings.get();
                        await this.reviews.createOrGet({ clubId: this.clubId, sourceChatId: training.chatId, sourceMessageId: message.messageId, sourceText: message.text, telegramUser: message.telegramUser, parsedCommand: command, candidateTrainingIds: resolution.trainings.map((item) => item.id), suggestedTrainingId: resolution.suggestedTraining?.id, reason: resolution.reason }, registrationReviewRecipients(settings.admins), resolution.trainings);
                        return { value: { kind: 'ambiguous' as const }, status: 'pending_ambiguity' as const };
                    }
                    if (resolution.kind === 'select') return { value: { kind: 'ambiguous' as const }, status: 'pending_ambiguity' as const };
                    await this.services.registration.executeCommandAgainstTraining(input, resolution.training.id);
                    return { value: { kind: 'processed' as const, trainingId: resolution.training.id }, trainingId: resolution.training.id };
                });
                if (result.duplicate) { skippedAlreadyProcessed++; continue; }
                if (result.value.kind === 'ambiguous') { ambiguousCount++; continue; }
                processedCount++;
                await this.publisher.refreshMessage(result.value.trainingId);
                logger.info('registration.recovery_message_processed', { ...fields, messageId: message.messageId });
            } catch (error) {
                logger.warn('registration.recovery_message_skipped', { ...fields, messageId: message.messageId, reason: error instanceof Error ? error.message : String(error) });
            }
        }
        logger.info('registration.recovery_completed', { ...fields, scannedCount: messages.length, processedCount, skippedAlreadyProcessed, invalidCount, ambiguousCount });
    }
}
