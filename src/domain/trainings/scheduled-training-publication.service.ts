import { SchedulerService } from '../../scheduler/scheduler.service';
import { logger } from '../../utils/logger';
import { ChatService } from '../chats/chat.service';
import { getZonedNow } from '../templates/template-scheduler.service';
import { TrainingPublisherService } from './training-publisher.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';
import { PublicationTrace, publicationTraceFields } from './publication-trace';

type SettingsSource = { get(): Promise<{ timezone: string }> };
type TrainingSource = { list(): Promise<Training[]> };

export class ScheduledTrainingPublicationService {
    constructor(
        private readonly scheduler: SchedulerService,
        private readonly source: TrainingSource,
        private readonly trainings: TrainingService,
        private readonly publisher: TrainingPublisherService,
        private readonly chats: ChatService,
        private readonly settings: SettingsSource,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async restore(): Promise<number> {
        const drafts = (await this.source.list()).filter((item) => item.status === 'draft' && item.scheduledPublicationAt);
        logger.info('training_publication.restore_started', { clubId: drafts[0]?.clubId, candidateCount: drafts.length });
        let restored = 0; let recovered = 0;
        for (const training of drafts) {
            try {
                const result = await this.schedule(training.id, true);
                if (result === 'scheduled') restored += 1;
                if (result === 'published') recovered += 1;
            } catch (error) {
                logger.error('training_publication.skipped', { clubId: training.clubId, trainingId: training.id, jobId: this.jobId(training), reason: 'restore_publication_failed', error });
            }
        }
        logger.info('training_publication.restore_completed', { clubId: drafts[0]?.clubId, candidateCount: drafts.length, restoredCount: restored, recoveredCount: recovered });
        return restored;
    }

    async schedule(trainingId: string, restoring = false): Promise<'scheduled' | 'published' | 'skipped'> {
        const training = await this.trainings.getRequired(trainingId);
        const jobId = this.jobId(training);
        this.scheduler.cancelTemplate(jobId);
        if (training.status !== 'draft' || !training.scheduledPublicationAt) {
            logger.info('training_publication.skipped', { clubId: training.clubId, trainingId, jobId, reason: training.status !== 'draft' ? 'already_published_or_inactive' : 'automatic_opening_not_configured' });
            return 'skipped';
        }
        const settings = await this.settings.get();
        const openAt = training.scheduledPublicationAt;
        const zonedNow = getZonedNow(this.now(), settings.timezone);
        const nowLocal = `${zonedNow.date}T${zonedNow.time}`;
        if (openAt <= nowLocal) {
            logger.warn('training_publication.overdue_detected', this.fields(training, settings.timezone, jobId));
            const published = await this.publishIfEligible(training.id, jobId, 'startup_recovery');
            if (published) logger.info('training_publication.recovered', this.fields(published, settings.timezone, jobId));
            return published ? 'published' : 'skipped';
        }
        this.scheduler.rescheduleOneOff({ id: jobId, date: openAt.slice(0, 10), time: openAt.slice(11, 16), timezone: settings.timezone, clubId: training.clubId, templateId: training.templateId, slotId: training.templateSlotId, trainingDate: training.date, trainingStartAt: `${training.date}T${training.startTime}`, triggerSource: 'cron' }, async () => {
            await this.publishIfEligible(training.id, jobId, 'cron');
        });
        logger.info('training_publication.scheduled', { ...this.fields(training, settings.timezone, jobId), registeredAt: this.now().toISOString(), restored: restoring });
        return 'scheduled';
    }

    private async publishIfEligible(trainingId: string, jobId: string, triggerSource: PublicationTrace['triggerSource']): Promise<Training | undefined> {
        const trace: PublicationTrace = { jobId, publicationAttemptId: jobId, triggerSource };
        const current = await this.trainings.getRequired(trainingId);
        if (current.status !== 'draft' || current.messageId || !current.scheduledPublicationAt) {
            logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: current.clubId, trainingId, reason: current.messageId || current.status !== 'draft' ? 'already_published' : 'publication_not_due' });
            return undefined;
        }
        const { timezone } = await this.settings.get();
        const now = getZonedNow(this.now(), timezone);
        if (`${current.date}T${current.startTime}` <= `${now.date}T${now.time}`) {
            logger.info('scheduler.job_skipped', { ...this.fields(current, timezone, jobId), ...publicationTraceFields(trace), reason: 'stale_occurrence' });
            return undefined;
        }
        const chat = await this.chats.getById(current.chatId);
        if (!chat?.enabled) {
            logger.error('training_publication.chat_resolution_failed', { ...this.fields(current, timezone, jobId), ...publicationTraceFields(trace), configuredChatId: current.chatId, resolutionSource: 'training', reason: 'missing_or_disabled' });
            return undefined;
        }
        logger.info('training_publication.chat_resolved', { ...this.fields(current, timezone, jobId), ...publicationTraceFields(trace), trainingId: current.id, configuredChatId: current.chatId, resolvedChatId: chat.id, chatTitle: chat.name, resolutionSource: 'training' });
        try {
            return await this.publisher.publishExistingDraft(current.id, trace);
        } catch (error) {
            logger.error('training_publication.telegram_send_failed', { ...this.fields(current, timezone, jobId), ...publicationTraceFields(trace), error });
            throw error;
        }
    }

    private jobId(training: Training): string { return `club:${training.clubId}:training:${training.id}`; }
    private fields(training: Training, timezone: string, jobId: string) {
        return { clubId: training.clubId, trainingId: training.id, templateId: training.templateId, chatId: training.chatId, trainingStartsAt: `${training.date}T${training.startTime}`, openAt: training.scheduledPublicationAt, timezone, jobId };
    }
}
