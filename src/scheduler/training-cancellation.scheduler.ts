import schedule, { Job } from 'node-schedule';
import { RepositoriesContext } from '../app/repositories.context';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { TrainingService } from '../domain/trainings/training.service';
import { Training } from '../domain/trainings/training.types';
import { logger } from '../utils/logger';

export class TrainingCancellationScheduler {
    private readonly jobs = new Map<string, Job>();

    constructor(
        private readonly repositories: RepositoriesContext,
        private readonly trainings: TrainingService,
        private readonly publisher: TrainingPublisherService,
    ) {}

    async restore(options: { reconcileOverdue?: boolean } = {}): Promise<void> {
        this.cancelAll();

        const activeTrainings =
            await this.repositories.trainings.listActive();

        for (const training of activeTrainings) {
            await this.schedule(training, options);
        }
    }

    async schedule(training: Training, options: { reconcileOverdue?: boolean } = { reconcileOverdue: true }): Promise<void> {
        this.cancel(training.id);

        if (
            training.status !== 'open'
        ) {
            return;
        }

        let hoursBefore = training.cancelCheckHoursBefore;
        if (hoursBefore === undefined && training.templateId) {
            const template = await this.repositories.templates.findById(training.templateId);
            hoursBefore = template?.cancelCheckHoursBefore;
        }

        const checkAt = this.getCheckDate(training, hoursBefore ?? 4);

        if (checkAt.getTime() <= Date.now()) {
            // Startup restore must never turn an overdue job into a destructive
            // cancellation. An explicit live reschedule may reconcile it.
            if (options.reconcileOverdue) await this.check(training.id);
            else logger.warn('scheduler.overdue_cancellation_requires_reconciliation', {
                clubId: this.repositories.clubId,
                trainingId: training.id,
                checkAt: checkAt.toISOString(),
            });
            return;
        }

        const job = schedule.scheduleJob(
            checkAt,
            async () => {
                try {
                    await this.check(training.id);
                } catch (error) {
                    logger.error('scheduler.cancellation_check_failed', { trainingId: training.id, error });
                } finally {
                    this.jobs.delete(training.id);
                }
            },
        );

        if (!job) {
            throw new Error(
                `Failed to schedule cancellation check for ${training.id}`,
            );
        }

        this.jobs.set(training.id, job);
        logger.info('scheduler.cancellation_check_scheduled', { trainingId: training.id, checkAt: checkAt.toISOString() });
    }

    cancel(trainingId: string): void {
        const job = this.jobs.get(trainingId);

        if (!job) {
            return;
        }

        job.cancel();
        this.jobs.delete(trainingId);
        logger.info('scheduler.cancellation_check_cancelled', { trainingId });
    }

    cancelAll(): void {
        for (const job of this.jobs.values()) {
            job.cancel();
        }

        this.jobs.clear();
    }

    getJobCount(): number {
        return this.jobs.size;
    }

    private async check(
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.trainings.getRequired(trainingId);

        if (
            training.status !== 'open'
        ) {
            return;
        }

        const registeredPlaces =
            training.participants.reduce(
                (sum, participant) =>
                    sum + participant.places,
                0,
            );

        if (
            registeredPlaces >= training.minPlayers
        ) {
            return;
        }

        await this.trainings.cancel(training.id);
        logger.info('scheduler.training_cancelled', { trainingId: training.id, registeredPlaces, minimumPlayers: training.minPlayers });
        await this.publisher.refreshMessage(training.id);
        await this.publisher.notifyCancellation(training.id);
    }

    private getCheckDate(
        training: Training,
        hoursBefore: number,
    ): Date {
        const trainingDate = new Date(
            `${training.date}T${training.startTime}:00`,
        );

        trainingDate.setHours(
            trainingDate.getHours() - hoursBefore,
        );

        return trainingDate;
    }
}
