import { SchedulerService } from '../../scheduler/scheduler.service';
import { SettingsRepository } from '../../storage/repositories/settings.repository';
import { ChatService } from '../chats/chat.service';
import { TrainingPublisherService } from '../trainings/training-publisher.service';
import { TemplateService } from './template.service';
import {
    TrainingTemplate,
    TrainingTemplateSlot,
} from './template.types';
import { resolveTemplateSlot } from './template.utils';
import { logger } from '../../utils/logger';
import { ScheduleExceptionService } from '../schedule-exceptions/schedule-exception.service';
import { ScheduleOccurrenceResolver } from '../schedule-exceptions/schedule-occurrence.resolver';
import { EffectiveOccurrence, ScheduleException } from '../schedule-exceptions/schedule-exception.types';
import { PublicationTrace, publicationTraceFields } from '../trainings/publication-trace';

type CreateTemplateInput =
    Parameters<TemplateService['create']>[0];
type UpdateTemplateInput =
    Parameters<TemplateService['update']>[1];

type ZonedNow = {
    date: string;
    time: string;
};
type SchedulerSyncStats = { overdueOccurrencesFound: number; overdueOccurrencesRecovered: number; occurrencesSkipped: number };

export class TemplateSchedulerService {
    constructor(
        private readonly templates: TemplateService,
        private readonly scheduler: SchedulerService,
        private readonly publisher: TrainingPublisherService,
        private readonly chats: ChatService,
        private readonly settings: SettingsRepository,
        private readonly now: () => Date = () => new Date(),
        private readonly exceptions?: ScheduleExceptionService,
        private readonly occurrenceResolver: ScheduleOccurrenceResolver = new ScheduleOccurrenceResolver(),
    ) {}

    async create(input: CreateTemplateInput): Promise<TrainingTemplate> {
        const template = await this.templates.create(input);
        await this.syncTemplate(template, true);
        return template;
    }

    async update(templateId: string, input: UpdateTemplateInput): Promise<TrainingTemplate> {
        const template = await this.templates.update(templateId, input);
        await this.syncTemplate(template, true);
        return template;
    }

    async enable(templateId: string): Promise<TrainingTemplate> {
        const template = await this.templates.enable(templateId);
        await this.syncTemplate(template, true);
        return template;
    }

    async disable(templateId: string): Promise<TrainingTemplate> {
        const template = await this.templates.disable(templateId);
        this.cancelTemplateJobs(template.clubId, template.id);
        return template;
    }

    async delete(templateId: string, deleteFutureExceptions = false): Promise<void> {
        const template = await this.templates.getRequired(templateId);
        if (this.exceptions) {
            const today = getZonedNow(this.now(), (await this.settings.get()).timezone).date;
            const count = await this.exceptions.countFutureForEntries(template.slots.map((slot) => slot.id), today);
            if (count && !deleteFutureExceptions) throw new Error(`SCHEDULE_HAS_EXCEPTIONS:${count}`);
            if (count) await this.exceptions.deleteForEntries(template.slots.map((slot) => slot.id));
        }
        this.cancelTemplateJobs(template.clubId, templateId);
        await this.templates.delete(templateId);
    }

    async restore(templates: TrainingTemplate[], options: { reconcileMissed?: boolean } = {}): Promise<number> {
        const clubId = templates[0]?.clubId ?? (await this.settings.get()).clubId;
        const slotsScanned = templates.reduce((total, template) => total + template.slots.length, 0);
        logger.info('scheduler.restore_started', { clubId, templatesScanned: templates.length, slotsScanned, reconcileMissed: options.reconcileMissed ?? false });
        this.scheduler.cancelByPrefix(`club:${clubId}:template:`);
        this.scheduler.cancelByPrefix(`club:${clubId}:exception:`);

        const stats: SchedulerSyncStats = { overdueOccurrencesFound: 0, overdueOccurrencesRecovered: 0, occurrencesSkipped: 0 };
        for (const template of templates) {
            const current = await this.syncTemplate(template, options.reconcileMissed ?? false);
            stats.overdueOccurrencesFound += current.overdueOccurrencesFound;
            stats.overdueOccurrencesRecovered += current.overdueOccurrencesRecovered;
            stats.occurrencesSkipped += current.occurrencesSkipped;
        }
        await this.syncExceptionJobs(templates);

        const snapshot = this.scheduler.getJobsSnapshot();
        logger.info('scheduler.jobs_snapshot', { clubId: templates[0]?.clubId ?? (await this.settings.get()).clubId, jobs: snapshot });

        const futureJobsRegistered = this.scheduler.getScheduledTemplateIds()
            .filter(id => id.startsWith('club:') && id.includes(':template:'))
            .length;
        logger.info('scheduler.restore_completed', { clubId, templatesScanned: templates.length, slotsScanned, futureJobsRegistered, activeJobs: snapshot.length, ...stats });
        return futureJobsRegistered;
    }

    async syncTemplate(
        template: TrainingTemplate,
        publishMissed = false,
    ): Promise<SchedulerSyncStats> {
        const stats: SchedulerSyncStats = { overdueOccurrencesFound: 0, overdueOccurrencesRecovered: 0, occurrencesSkipped: 0 };
        this.cancelTemplateJobs(template.clubId, template.id);

        if (!template.enabled) {
            logger.info('training_publication.skipped', { clubId: template.clubId, templateId: template.id, reason: 'TEMPLATE_PAUSED' });
            stats.occurrencesSkipped = template.slots.length;
            return stats;
        }
        if (!template.slots.length) {
            throw new Error(`Template ${template.id} has no slots`);
        }

        const { timezone } = await this.settings.get();

        for (const slot of template.slots) {
            if (!slot.enabled) {
                logger.info('training_publication.skipped', { clubId: template.clubId, templateId: template.id, slotId: slot.id, reason: 'SLOT_DISABLED' });
                stats.occurrencesSkipped += 1;
                continue;
            }
            this.scheduleSlot(template, slot, timezone);

            if (publishMissed) {
                try {
                    const recovered = await this.publishMissedIfRelevant(
                        template,
                        slot,
                        timezone,
                    );
                    if (recovered) { stats.overdueOccurrencesFound += 1; stats.overdueOccurrencesRecovered += 1; }
                } catch (error) {
                    logger.error('scheduler.missed_publication_failed', { jobId: this.getSlotJobId(template.clubId, template.id, slot.id), clubId: template.clubId, templateId: template.id, slotId: slot.id, error });
                }
            }
        }
        return stats;
    }

    private scheduleSlot(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
        timezone: string,
    ): void {
        const resolved = resolveTemplateSlot(template, slot);
        const jobId = this.getSlotJobId(template.clubId, template.id, slot.id);

        logger.info('scheduler.slot_registering', {
            clubId: template.clubId,
            templateId: template.id,
            slotId: slot.id,
            dayOfWeek: resolved.dayOfWeek,
            trainingStartTime: resolved.startTime,
            publishRule: { daysBefore: resolved.publishDaysBefore },
            publishTime: resolved.publishTime,
            timezone,
            jobId,
        });
        const zonedNow = getZonedNow(this.now(), timezone);
        const nextTrainingDate = findNearestFutureTrainingDate(zonedNow, resolved.dayOfWeek, resolved.startTime);
        const publicationDate = addCalendarDays(nextTrainingDate, -resolved.publishDaysBefore);
        logger.info('training_publication.scheduled', {
            clubId: template.clubId, templateId: template.id, slotId: slot.id, chatId: template.chatId,
            trainingStartsAt: `${nextTrainingDate}T${resolved.startTime}`,
            openAt: `${publicationDate}T${resolved.publishTime}`,
            localPublishAt: `${publicationDate}T${resolved.publishTime}`,
            timezone, currentTime: `${zonedNow.date}T${zonedNow.time}`, jobId, registeredAt: this.now().toISOString(),
        });

        this.scheduler.rescheduleTemplate(
            {
                id: jobId,
                dayOfWeek: calculatePublishDayOfWeek(
                    resolved.dayOfWeek,
                    resolved.publishDaysBefore,
                ),
                publishTime: resolved.publishTime,
                timezone,
                clubId: template.clubId,
                templateId: template.id,
                slotId: slot.id,
                trainingDate: nextTrainingDate,
                trainingStartAt: `${nextTrainingDate}T${resolved.startTime}`,
                scheduledFor: `${publicationDate}T${resolved.publishTime}`,
                currentTime: `${zonedNow.date}T${zonedNow.time}`,
                triggerSource: 'cron',
            },
            async () => {
                const trace: PublicationTrace = { jobId, publicationAttemptId: jobId, triggerSource: 'cron' };
                try {
                    const currentTemplate =
                        await this.templates.getRequired(template.id);
                    const currentSlot = currentTemplate.slots.find(
                        item => item.id === slot.id,
                    );

                    if (!currentTemplate.enabled || !currentSlot?.enabled) {
                        logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: currentTemplate.clubId, templateId: currentTemplate.id, slotId: slot.id, reason: !currentTemplate.enabled ? 'template_disabled' : 'slot_disabled' });
                        this.scheduler.cancelTemplate(jobId);
                        return;
                    }

                    const currentResolved =
                        resolveTemplateSlot(currentTemplate, currentSlot);
                    const publicationDate = getZonedNow(this.now(), timezone).date;
                    const trainingDate = addCalendarDays(
                        publicationDate,
                        currentResolved.publishDaysBefore,
                    );
                    const currentPublicationDate = addCalendarDays(trainingDate, -currentResolved.publishDaysBefore);

                    logger.info('scheduler.job_occurrence_resolved', { ...publicationTraceFields(trace), clubId: currentTemplate.clubId, templateId: currentTemplate.id, slotId: currentSlot.id, trainingDate, startTime: currentResolved.startTime, publishAt: `${currentPublicationDate}T${currentResolved.publishTime}`, timezone });
                    await this.publishSlot(currentTemplate, currentSlot, trainingDate, trace);
                } catch (error) {
                    logger.error('scheduler.automatic_publication_failed', { jobId, clubId: template.clubId, templateId: template.id, slotId: slot.id, stage: 'occurrence_or_publication', error });
                    throw error;
                }
            },
        );
        const scheduled = this.scheduler.getJobsSnapshot().find((job) => job.jobId === jobId);
        logger.info('scheduler.slot_scheduled', {
            clubId: template.clubId,
            templateId: template.id,
            slotId: slot.id,
            trainingDate: nextTrainingDate,
            trainingStart: resolved.startTime,
            openAt: `${publicationDate}T${resolved.publishTime}`,
            timezone,
            now: `${zonedNow.date}T${zonedNow.time}`,
            jobId,
            nextRunAt: scheduled?.nextRunAt,
            jobRegistered: Boolean(scheduled),
        });
        if (!scheduled) {
            logger.error('scheduler.slot_skipped', { clubId: template.clubId, templateId: template.id, slotId: slot.id, jobId, reason: 'JOB_NOT_REGISTERED' });
        }
    }

    private async publishMissedIfRelevant(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
        timezone: string,
    ): Promise<boolean> {
        const resolved = resolveTemplateSlot(template, slot);
        const zonedNow = getZonedNow(this.now(), timezone);
        const trainingDate = findNearestFutureTrainingDate(
            zonedNow,
            resolved.dayOfWeek,
            resolved.startTime,
        );
        const publicationDate = addCalendarDays(
            trainingDate,
            -resolved.publishDaysBefore,
        );

        if (
            publicationDate < zonedNow.date ||
            (
                publicationDate === zonedNow.date &&
                resolved.publishTime <= zonedNow.time
            )
        ) {
            const jobId = this.getSlotJobId(template.clubId, template.id, slot.id);
            logger.warn('training_publication.overdue_detected', { clubId: template.clubId, templateId: template.id, slotId: slot.id, chatId: template.chatId, trainingStartsAt: `${trainingDate}T${resolved.startTime}`, openAt: `${publicationDate}T${resolved.publishTime}`, timezone, jobId });
            await this.publishSlot(template, slot, trainingDate, { jobId, publicationAttemptId: jobId, triggerSource: 'startup_recovery' });
            logger.info('training_publication.recovered', { clubId: template.clubId, templateId: template.id, slotId: slot.id, chatId: template.chatId, trainingStartsAt: `${trainingDate}T${resolved.startTime}`, openAt: `${publicationDate}T${resolved.publishTime}`, timezone, jobId });
            return true;
        }
        return false;
    }

    private async publishSlot(
        template: TrainingTemplate,
        slot: TrainingTemplateSlot,
        trainingDate: string,
        trace: PublicationTrace,
    ): Promise<void> {
        const exception = await this.exceptions?.findForOccurrence(slot.id, trainingDate);
        const occurrence = this.occurrenceResolver.resolveRecurring(template, slot, trainingDate, exception);
        if (!occurrence?.publicationEnabled) {
            logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: template.clubId, templateId: template.id, slotId: slot.id, date: trainingDate, reason: exception?.type === 'cancel' ? 'occurrence_cancelled' : 'occurrence_not_found' });
            return;
        }
        // A changed publication time is handled by its one-off job, not by the recurring job.
        const resolved = resolveTemplateSlot(template, slot);
        if (exception?.type === 'override' && occurrence.publishTime !== resolved.publishTime) {
            logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: template.clubId, templateId: template.id, slotId: slot.id, date: trainingDate, reason: 'stale_occurrence' });
            return;
        }
        await this.publishOccurrence(occurrence, trace);
    }

    private async publishOccurrence(occurrence: EffectiveOccurrence, trace: PublicationTrace): Promise<void> {
        const chat = await this.chats.getById(occurrence.chatId);
        if (!chat?.enabled) {
            logger.error('training_publication.chat_resolution_failed', { ...publicationTraceFields(trace), clubId: occurrence.clubId, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, configuredChatId: occurrence.chatId, resolutionSource: occurrence.exceptionId ? 'schedule_exception' : 'template', trainingStartsAt: `${occurrence.date}T${occurrence.startTime}`, reason: 'missing_or_disabled' });
            throw new Error(`Schedule publication chat ${occurrence.chatId} is missing or disabled`);
        }
        logger.info('training_publication.chat_resolved', { ...publicationTraceFields(trace), clubId: occurrence.clubId, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, configuredChatId: occurrence.chatId, resolvedChatId: chat.id, chatTitle: chat.name, resolutionSource: occurrence.exceptionId ? 'schedule_exception' : 'template' });
        const training = await this.publisher.publishTemplateSlot({
            templateId: occurrence.scheduleId ?? `exception:${occurrence.exceptionId}`,
            slotId: occurrence.scheduleEntryId ?? 'extra', clubId: occurrence.clubId, chatId: occurrence.chatId,
            title: occurrence.title, location: occurrence.location, date: occurrence.date, startTime: occurrence.startTime,
            endTime: occurrence.endTime, placesLimit: occurrence.placesLimit, minPlayers: occurrence.minPlayers,
            cancelCheckHoursBefore: occurrence.cancelCheckHoursBefore,
            trace,
        });
        logger.info('training_publication.attempt_completed', { ...publicationTraceFields(trace), clubId: occurrence.clubId, trainingId: training.id, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, date: occurrence.date, chatId: occurrence.chatId, messageId: training.messageId });
    }

    async syncExceptionJobs(currentTemplates?: TrainingTemplate[]): Promise<void> {
        if (!this.exceptions) return;
        const settings = await this.settings.get();
        const templates = currentTemplates ?? await this.templates.listByClubId(settings.clubId);
        const { timezone } = settings;
        const zonedNow = getZonedNow(this.now(), timezone);
        this.scheduler.cancelByPrefix(`club:${templates[0]?.clubId ?? settings.clubId}:exception:`);
        const byEntry = new Map(templates.flatMap((template) => template.slots.map((slot) => [slot.id, { template, slot }] as const)));
        for (const exception of await this.exceptions.list()) {
            let occurrence: EffectiveOccurrence | undefined;
            if (exception.type === 'extra') occurrence = this.occurrenceResolver.resolveExtra(exception);
            else { const base = exception.scheduleEntryId ? byEntry.get(exception.scheduleEntryId) : undefined; if (base) occurrence = this.occurrenceResolver.resolveRecurring(base.template, base.slot, exception.date, exception); }
            if (!occurrence?.publicationEnabled || exception.type === 'cancel') continue;
            const base = exception.scheduleEntryId ? byEntry.get(exception.scheduleEntryId) : undefined;
            const basePublishTime = base ? resolveTemplateSlot(base.template, base.slot).publishTime : undefined;
            if (exception.type === 'override' && occurrence.publishTime === basePublishTime) continue;
            const publicationDate = addCalendarDays(occurrence.date, -occurrence.publishDaysBefore);
            const jobId = this.getExceptionJobId(exception);
            const publicationAlreadyDue = publicationDate < zonedNow.date
                || (publicationDate === zonedNow.date && occurrence.publishTime <= zonedNow.time);
            const trainingStillFuture = occurrence.date > zonedNow.date
                || (occurrence.date === zonedNow.date && occurrence.startTime > zonedNow.time);
            if (publicationAlreadyDue && trainingStillFuture) {
                try {
                    await this.publishOccurrence(occurrence, { jobId, publicationAttemptId: jobId, triggerSource: 'startup_recovery' });
                } catch (error) {
                    logger.error('scheduler.missed_publication_failed', { jobId, clubId: occurrence.clubId, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, stage: 'exception_recovery', error });
                }
                continue;
            }
            this.scheduler.rescheduleOneOff({ id: jobId, date: publicationDate, time: occurrence.publishTime, timezone, clubId: occurrence.clubId, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, trainingDate: occurrence.date, trainingStartAt: `${occurrence.date}T${occurrence.startTime}`, triggerSource: 'cron' }, async () => {
                const trace: PublicationTrace = { jobId, publicationAttemptId: jobId, triggerSource: 'cron' };
                const latest = await this.exceptions!.findById(exception.id); if (!latest) { logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: occurrence.clubId, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, reason: 'occurrence_not_found' }); return; }
                const current = latest.type === 'extra' ? this.occurrenceResolver.resolveExtra(latest) : latest.scheduleEntryId && byEntry.get(latest.scheduleEntryId)
                    ? this.occurrenceResolver.resolveRecurring(byEntry.get(latest.scheduleEntryId)!.template, byEntry.get(latest.scheduleEntryId)!.slot, latest.date, latest) : undefined;
                if (current) await this.publishOccurrence(current, trace);
                else logger.info('scheduler.job_skipped', { ...publicationTraceFields(trace), clubId: occurrence.clubId, templateId: occurrence.scheduleId, slotId: occurrence.scheduleEntryId, reason: 'occurrence_not_found' });
            });
        }
    }

    async publishExceptionNow(exceptionId: string): Promise<void> {
        if (!this.exceptions) throw new Error('Винятки розкладу недоступні.');
        const exception = await this.exceptions.findById(exceptionId);
        if (!exception) throw new Error('Виняток не знайдено.');
        const templates = await this.templates.listByClubId(exception.clubId);
        let occurrence: EffectiveOccurrence | undefined;
        if (exception.type === 'extra') occurrence = this.occurrenceResolver.resolveExtra({ ...exception, publicationEnabled: true });
        else if (exception.scheduleEntryId) {
            const template = templates.find((item) => item.slots.some((slot) => slot.id === exception.scheduleEntryId));
            const slot = template?.slots.find((item) => item.id === exception.scheduleEntryId);
            if (template && slot) occurrence = this.occurrenceResolver.resolveRecurring(template, slot, exception.date, { ...exception, publicationEnabled: true });
        }
        if (!occurrence || exception.type === 'cancel') throw new Error('Цю дату не можна опублікувати.');
        const jobId = this.getExceptionJobId(exception);
        await this.publishOccurrence(occurrence, { jobId, publicationAttemptId: jobId, triggerSource: 'manual_admin' });
    }

    private getExceptionJobId(exception: ScheduleException): string { return `club:${exception.clubId}:exception:${exception.id}`; }

    private cancelTemplateJobs(clubId: string, templateId: string): void {
        this.scheduler.cancelByPrefix(`club:${clubId}:template:${templateId}:slot:`);
    }

    private getSlotJobId(clubId: string, templateId: string, slotId: string): string {
        return `club:${clubId}:template:${templateId}:slot:${slotId}`;
    }
}

export function calculatePublishDayOfWeek(
    trainingDayOfWeek: number,
    publishDaysBefore: number,
): number {
    return ((trainingDayOfWeek - publishDaysBefore - 1) % 7 + 7) % 7 + 1;
}

export function addCalendarDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

export function findNearestFutureTrainingDate(
    now: ZonedNow,
    dayOfWeek: number,
    startTime: string,
): string {
    for (let offset = 0; offset <= 7; offset += 1) {
        const date = addCalendarDays(now.date, offset);
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
        if (
            weekday === dayOfWeek &&
            (offset > 0 || startTime > now.time)
        ) {
            return date;
        }
    }
    return addCalendarDays(now.date, 7);
}

export function getZonedNow(value: Date, timezone: string): ZonedNow {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find(part => part.type === type)?.value ?? '';
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${get('hour')}:${get('minute')}`,
    };
}
