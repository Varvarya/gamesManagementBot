import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { Training } from '../../../domain/trainings/training.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import {
    createActiveTrainingsKeyboard,
    createTrainingCancelKeyboard,
    createTrainingKeyboard,
} from '../keyboards/training.keyboard';
import {
    formatDate,
    formatTimeRange,
    renderTrainingCard,
} from '../ui/admin-formatters';

export class AdminTrainingHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.ActiveTrainings ||
            callback.startsWith(
                AdminCallbacks.TrainingPrefix,
            )
        );
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (
            callback ===
            AdminCallbacks.ActiveTrainings
        ) {
            await this.showList(ctx);
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingCancelConfirmPrefix,
            )
        ) {
            await this.cancel(
                ctx,
                callback.replace(
                    AdminCallbacks.TrainingCancelConfirmPrefix,
                    '',
                ),
            );
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingCancelPrefix,
            )
        ) {
            await this.confirmCancel(
                ctx,
                callback.replace(
                    AdminCallbacks.TrainingCancelPrefix,
                    '',
                ),
            );
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingRefreshPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingRefreshPrefix,
                '',
            );

            await this.publisher.refreshMessage(
                trainingId,
            );

            await this.show(ctx, trainingId);
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingClosePrefix,
            )
        ) {
            const training =
                await this.services.trainings.close(
                    callback.replace(
                        AdminCallbacks.TrainingClosePrefix,
                        '',
                    ),
                );

            await this.publisher.refreshMessage(
                training.id,
            );

            await this.show(ctx, training.id);
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingOpenPrefix,
            )
        ) {
            const training =
                await this.services.trainings.open(
                    callback.replace(
                        AdminCallbacks.TrainingOpenPrefix,
                        '',
                    ),
                );

            await this.publisher.refreshMessage(
                training.id,
            );

            await this.show(ctx, training.id);
            return;
        }

        await this.show(
            ctx,
            callback.replace(
                AdminCallbacks.TrainingPrefix,
                '',
            ),
        );
    }

    private async showList(
        ctx: Context,
    ): Promise<void> {
        const trainings =
            await this.services.repositories.trainings.listActive();

        trainings.sort(
            (first, second) =>
                this.timestamp(first) -
                this.timestamp(second),
        );

        await this.services.adminUi.show(
            ctx,
            [
                '🏸 Активні тренування',
                '',
                trainings.length > 0
                    ? `Знайдено: ${trainings.length}`
                    : 'Активних тренувань немає',
                '',
                trainings.length > 0
                    ? 'Оберіть тренування'
                    : 'Нові тренування зʼявляться тут після публікації',
            ].join('\n'),
            createActiveTrainingsKeyboard(
                trainings,
            ),
        );
    }

    private async show(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        await this.services.adminUi.show(
            ctx,
            renderTrainingCard(training),
            createTrainingKeyboard(training),
        );
    }

    private async confirmCancel(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        await this.services.adminUi.show(
            ctx,
            [
                '❌ Скасувати тренування?',
                '',
                `🏸 ${training.title}`,
                `📅 ${formatDate(training.date)}`,
                `🕐 ${formatTimeRange(
                    training.startTime,
                    training.endTime,
                )}`,
                '',
                'Учасники побачать оновлений статус в оголошенні',
            ].join('\n'),
            createTrainingCancelKeyboard(
                training.id,
            ),
        );
    }

    private async cancel(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.cancel(
                trainingId,
            );

        await this.publisher.refreshMessage(
            training.id,
        );

        await this.showList(ctx);
    }

    private timestamp(
        training: Training,
    ): number {
        return new Date(
            `${training.date}T${training.startTime}`,
        ).getTime();
    }
}