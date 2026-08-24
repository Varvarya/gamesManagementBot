import { ServicesContext } from '../../app/services.context';
import { logger } from '../../utils/logger';
import { TelegramHistoryBatch, TelegramHistoryMessage, TelegramUserConnectionManager } from '../telegram-import/telegram-user-connection.manager';
import { registrationCommandParser, RegistrationCommandParseError } from './registration-command.parser';
import { ProcessedRegistrationMessageStore } from './processed-registration-message.store';
import { explicitRegistrationTimeMismatch, RegistrationService } from './registration.service';
import { RegistrationReviewService, registrationReviewRecipients } from './registration-review.service';
import { TrainingParticipantsService } from './training-participants.service';
import { TrainingPublisherService } from './training-publisher.service';
import { TrainingRegistrationLock } from './training-registration-lock';
import { ParticipantEntry, Training } from './training.types';
import { TrainingService } from './training.service';

export type RegistrationReconciliationResult = {
    complete: boolean; stateChanged: boolean; messagesScanned: number; commandsParsed: number; commandsApplied: number; commandsRejected: number;
    pendingReviews: number; previousActivePlaces: number; newActivePlaces: number;
    previousWaitingPlaces: number; newWaitingPlaces: number;
};

/** Rebuilds chat-derived registration state; this is intentionally the single startup/manual path. */
export class RegistrationRecoveryService {
    constructor(
        private readonly clubId: string,
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
        private readonly connections: Pick<TelegramUserConnectionManager, 'readRecentMessages'>,
        // Retained for live/recovery persistence compatibility. Full reconciliation
        // deliberately does not use processed flags as a replay filter.
        private readonly _processed: ProcessedRegistrationMessageStore,
        private readonly reviews?: RegistrationReviewService,
        private readonly historyLimit = 500,
        private readonly lock = new TrainingRegistrationLock(),
    ) {}

    async recoverActive(): Promise<void> {
        const all = await this.services.repositories.trainings.list();
        for (const training of all.filter((item) => item.status === 'open' && item.messageId === undefined)) {
            logger.warn('registration.reconciliation_unavailable', { clubId: this.clubId, trainingId: training.id, chatId: training.chatId, reason: 'publication_message_identity_missing' });
        }
        const trainings = all.filter((item) => this.services.trainings.isRelevantOpen(item, item.chatId));
        for (const training of trainings) await this.recoverTraining(training);
    }

    async reconcileTraining(trainingId: string): Promise<RegistrationReconciliationResult> {
        return this.recoverTraining(await this.services.trainings.getRequired(trainingId));
    }

    async forceReconcileTraining(trainingId: string): Promise<RegistrationReconciliationResult> {
        const training = await this.services.trainings.getRequired(trainingId);
        const initial = resultFor(training);
        logger.info('registration.force_reconciliation_started', forceFields(training, initial));
        try {
            const result = await this.recoverTraining(training, true);
            if (!result.complete) {
                logger.warn('registration.force_reconciliation_failed', { ...forceFields(training, result), reason: 'history_incomplete' });
                return result;
            }
            logger.info('registration.force_reconciliation_completed', forceFields(training, result));
            return result;
        } catch (error) {
            logger.error('registration.force_reconciliation_failed', { ...forceFields(training, initial), error });
            throw error;
        }
    }

    async recoverTraining(training: Training, failOnMessageRefresh = false): Promise<RegistrationReconciliationResult> {
        return this.lock.run(training.id, async () => {
            const current = await this.services.trainings.getRequired(training.id);
            const empty = resultFor(current);
            if (current.status !== 'open') return empty;
            if (current.messageId === undefined) {
                logger.warn('registration.reconciliation_unavailable', { clubId: this.clubId, trainingId: current.id, chatId: current.chatId, reason: 'publication_message_identity_missing' });
                return empty;
            }
            const openedAt = current.registrationOpenedAt ?? current.publishedAt;
            const fields = { clubId: this.clubId, trainingId: current.id, chatId: current.chatId };
            if (!openedAt) {
                logger.warn('registration.reconciliation_unavailable', { ...fields, reason: 'opening_boundary_missing' });
                return empty;
            }
            logger.info('registration.reconciliation_started', { ...fields, registrationOpenedAt: openedAt, openingMessageId: current.messageId });
            let batch: TelegramHistoryBatch;
            try {
                batch = await this.connections.readRecentMessages(this.clubId, current.chatId, new Date(openedAt), this.historyLimit, current.messageId);
            } catch (error) {
                logger.warn('registration.reconciliation_unavailable', { ...fields, reason: error instanceof Error ? error.message : String(error) });
                return empty;
            }
            // Backward-compatible guard for local adapters while callers migrate.
            if (Array.isArray(batch)) batch = { messages: batch as TelegramHistoryMessage[], complete: true };
            const messages = batch.messages.filter((item) => item.messageId > current.messageId!).sort(compareMessages);
            if (!batch.complete) {
                logger.warn('registration.reconciliation_incomplete', { ...fields, messagesScanned: messages.length, historyLimit: this.historyLimit });
                return { ...empty, messagesScanned: messages.length };
            }

            const baseline = clone(current);
            baseline.participants = baseline.participants.filter(isBaseline);
            baseline.waitlist = baseline.waitlist.filter(isBaseline);
            const allOpen = (await this.services.trainings.listRelevantOpenByChatId(current.chatId)).map(clone);
            const state = new Map(allOpen.map((item) => [item.id, item]));
            state.set(baseline.id, baseline);
            const memory = new MemoryTrainingService(state);
            const participantService = new TrainingParticipantsService(memory as unknown as TrainingService);
            const registration = new RegistrationService(this.services.players, memory as unknown as TrainingService, participantService, async () => (await this.services.repositories.settings.get()).timezone);
            let commandsParsed = 0; let commandsApplied = 0; let commandsRejected = 0; let pendingReviews = 0;

            for (const message of messages) {
                let command;
                try { command = registrationCommandParser.parse(message.text); }
                catch (error) { if (error instanceof RegistrationCommandParseError) continue; throw error; }
                if (!command) continue;
                commandsParsed++;
                if (explicitRegistrationTimeMismatch(current, command)) commandsRejected++;
                const input = { telegramUser: message.telegramUser, chatId: current.chatId, replyToMessageId: message.replyToMessageId, command };
                try {
                    const existingReview = await this.reviews?.findBySource(this.clubId, current.chatId, message.messageId);
                    if (existingReview) {
                        if (existingReview.status === 'resolved' && existingReview.resolution === 'accepted' && existingReview.resolvedTrainingId === current.id) {
                            const mutations = await registration.executeCommandAgainstTraining(input, current.id);
                            if (mutations.length) commandsApplied++;
                        } else if (existingReview.status === 'pending') pendingReviews++;
                        continue;
                    }
                    const resolution = await registration.resolveCommand(input);
                    if (resolution.kind === 'ready') {
                        if (resolution.training.id === current.id) {
                            const mutations = await registration.executeCommandAgainstTraining(input, current.id);
                            if (mutations.length) commandsApplied++;
                        }
                        continue;
                    }
                    if (resolution.kind === 'suspicious') {
                        if (this.reviews && resolution.trainings.some((item) => item.id === current.id)) {
                            const settings = await this.services.repositories.settings.get();
                            await this.reviews.createOrGet({ clubId: this.clubId, sourceChatId: current.chatId, sourceMessageId: message.messageId, sourceText: message.text, telegramUser: message.telegramUser, parsedCommand: command, candidateTrainingIds: resolution.trainings.map((item) => item.id), suggestedTrainingId: resolution.suggestedTraining?.id, reason: resolution.reason }, registrationReviewRecipients(settings.admins), resolution.trainings);
                            pendingReviews++;
                        }
                    } else if (resolution.kind === 'select' && resolution.trainings.some((item) => item.id === current.id)) pendingReviews++;
                } catch (error) {
                    logger.warn('registration.reconciliation_message_skipped', { ...fields, messageId: message.messageId, reason: error instanceof Error ? error.message : String(error) });
                }
            }

            const rebuilt = await memory.getRequired(current.id);
            const changed = !sameRegistrationState(current, rebuilt);
            if (changed) {
                rebuilt.updatedAt = new Date().toISOString();
                await this.services.repositories.trainings.save(rebuilt);
                try { await this.publisher.refreshMessage(rebuilt.id); }
                catch (error) {
                    logger.warn('registration.reconciliation_card_refresh_failed', { ...fields, error });
                    if (failOnMessageRefresh) throw error;
                }
            }
            const result = {
                complete: true, stateChanged: changed, messagesScanned: messages.length, commandsParsed, commandsApplied, commandsRejected, pendingReviews,
                previousActivePlaces: places(current.participants), newActivePlaces: places(rebuilt.participants),
                previousWaitingPlaces: places(current.waitlist), newWaitingPlaces: places(rebuilt.waitlist),
            };
            logger.info('registration.reconciliation_completed', { ...fields, ...result });
            return result;
        });
    }
}

class MemoryTrainingService {
    constructor(private readonly state: Map<string, Training>) {}
    async getRequired(id: string): Promise<Training> { const value = this.state.get(id); if (!value) throw new Error(`Training ${id} not found`); return value; }
    async save(training: Training): Promise<Training> { this.state.set(training.id, training); return training; }
    async findByMessageId(chatId: number, messageId: number): Promise<Training | undefined> { return [...this.state.values()].find((item) => item.chatId === chatId && item.messageId === messageId); }
    async listRelevantOpenByChatId(chatId: number): Promise<Training[]> { return [...this.state.values()].filter((item) => this.isRelevantOpen(item, chatId)); }
    isRelevantOpen(training: Training, chatId: number): boolean { return training.chatId === chatId && training.status === 'open' && training.messageId !== undefined; }
}

function isBaseline(entry: ParticipantEntry): boolean { return entry.source === 'admin'; }
function clone<T>(value: T): T { return structuredClone(value); }
function places(entries: ParticipantEntry[]): number { return entries.reduce((sum, item) => sum + item.places, 0); }
function compareMessages(a: TelegramHistoryMessage, b: TelegramHistoryMessage): number { return a.date.getTime() - b.date.getTime() || a.messageId - b.messageId; }
function signature(entries: ParticipantEntry[]): unknown { return entries.map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...entry }) => entry); }
function sameRegistrationState(a: Training, b: Training): boolean { return JSON.stringify([signature(a.participants), signature(a.waitlist)]) === JSON.stringify([signature(b.participants), signature(b.waitlist)]); }
function resultFor(training: Training): RegistrationReconciliationResult { return { complete: false, stateChanged: false, messagesScanned: 0, commandsParsed: 0, commandsApplied: 0, commandsRejected: 0, pendingReviews: 0, previousActivePlaces: places(training.participants), newActivePlaces: places(training.participants), previousWaitingPlaces: places(training.waitlist), newWaitingPlaces: places(training.waitlist) }; }
function forceFields(training: Training, result: RegistrationReconciliationResult): Record<string, unknown> {
    return { trainingId: training.id, chatId: training.chatId, ...result };
}
