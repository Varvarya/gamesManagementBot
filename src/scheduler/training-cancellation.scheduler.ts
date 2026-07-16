import schedule, { Job } from 'node-schedule';
import { RepositoriesContext } from '../app/repositories.context';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { TrainingService } from '../domain/trainings/training.service';
import { Training } from '../domain/trainings/training.types';

export class TrainingCancellationScheduler {
    private readonly jobs = new Map<string, Job>();

    constructor(
        private readonly repositories: RepositoriesContext,
        private readonly trainings: TrainingService,
        private readonly publisher: TrainingPublisherService,
    ) {}

    async restore(): Promise<void> {
        this.cancelAll();

        const activeTrainings =
            await this.repositories.trainings.listActive();

        for (const training of activeTrainings) {
            await this.schedule(training);
        }
    }

    async schedule(training: Training): Promise<void> {
        this.cancel(training.id);

        if (
            training.status !== 'open' &&
            training.status !== 'closed'
        ) {
            return;
        }

        const settings =
            await this.repositories.settings.get();

        const checkAt = this.getCheckDate(
            training,
            settings.cancelCheckHoursBefore,
        );

        if (checkAt.getTime() <= Date.now()) {
            await this.check(training.id);
            return;
        }

        const job = schedule.scheduleJob(
            checkAt,
            async () => {
                try {
                    await this.check(training.id);
                } catch (error) {
                    console.error(
                        `Failed to check training ${training.id}`,
                        error,
                    );
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
    }

    cancel(trainingId: string): void {
        const job = this.jobs.get(trainingId);

        if (!job) {
            return;
        }

        job.cancel();
        this.jobs.delete(trainingId);
    }

    cancelAll(): void {
        for (const job of this.jobs.values()) {
            job.cancel();
        }

        this.jobs.clear();
    }

    private async check(
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.trainings.getRequired(trainingId);

        if (
            training.status !== 'open' &&
            training.status !== 'closed'
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
        await this.publisher.refreshMessage(training.id);
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