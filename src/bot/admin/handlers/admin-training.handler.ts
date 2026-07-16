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
import {TrainingCancellationScheduler} from "../../../scheduler/training-cancellation.scheduler";

export class AdminTrainingHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
        private readonly cancellationScheduler: TrainingCancellationScheduler,
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
        if (!ctx.from) {
            return;
        }

        if (
            callback === AdminCallbacks.ActiveTrainings
        ) {
            await this.showActive(ctx);
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingCancelConfirmPrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingCancelConfirmPrefix,
            );

            const training =
                await this.services.trainings.cancel(id);

            this.cancellationScheduler.cancel(
                training.id,
            );

            await this.publisher.refreshMessage(id);
            await this.showActive(ctx);

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingCancelPrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingCancelPrefix,
            );

            const training =
                await this.services.trainings.getRequired(id);

            await ctx.editMessageText(
                [
                    '❌ Скасувати тренування?',
                    '',
                    `🏸 ${training.title}`,
                    `📅 ${training.date}`,
                ].join('\n'),
                createTrainingCancelKeyboard(id),
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingRefreshPrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingRefreshPrefix,
            );

            await this.publisher.refreshMessage(id);
            await this.showTraining(ctx, id);

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingClosePrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingClosePrefix,
            );

            await this.services.trainings.close(id);
            await this.publisher.refreshMessage(id);
            await this.showTraining(ctx, id);

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingOpenPrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingOpenPrefix,
            );

            await this.services.trainings.open(id);
            await this.publisher.refreshMessage(id);
            await this.showTraining(ctx, id);

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingSelectAddPlayerPrefix,
            )
        ) {
            const value = this.getId(
                callback,
                AdminCallbacks.TrainingSelectAddPlayerPrefix,
            );

            const [trainingId, playerId] =
                value.split(':');

            const player =
                await this.services.repositories.players.findById(
                    playerId,
                );

            if (!player) {
                throw new Error(
                    `Player ${playerId} not found`,
                );
            }

            await this.services.trainingParticipants.addOrUpdateParticipant({
                trainingId,
                playerId,
                telegramUserId:
                player.telegramUserId,
                places: 1,
                source: 'admin',
            });

            await this.publisher.refreshMessage(
                trainingId,
            );

            await this.showTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingSelectRemovePlayerPrefix,
            )
        ) {
            const value = this.getId(
                callback,
                AdminCallbacks.TrainingSelectRemovePlayerPrefix,
            );

            const [trainingId, playerId] =
                value.split(':');

            await this.services.trainingParticipants.removeParticipantCompletely({
                trainingId,
                playerId,
            });

            await this.publisher.refreshMessage(
                trainingId,
            );

            await this.showTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingAddPlayerPrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingAddPlayerPrefix,
            );

            this.services.adminFlow.transition(
                ctx.from.id,
                'waiting_training_add_player',
                {
                    trainingId: id,
                },
            );

            await ctx.editMessageText(
                '➕ Додати гравця\n\nВведіть імʼя або частину імені',
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingRemovePlayerPrefix,
            )
        ) {
            const id = this.getId(
                callback,
                AdminCallbacks.TrainingRemovePlayerPrefix,
            );

            this.services.adminFlow.transition(
                ctx.from.id,
                'waiting_training_remove_player',
                {
                    trainingId: id,
                },
            );

            await ctx.editMessageText(
                '➖ Прибрати гравця\n\nВведіть імʼя або частину імені',
            );

            return;
        }

        const id = this.getId(
            callback,
            AdminCallbacks.TrainingPrefix,
        );

        await this.showTraining(ctx, id);
    }

    private async showActive(
        ctx: Context,
    ): Promise<void> {
        const trainings =
            await this.services.repositories.trainings.listActive();

        trainings.sort(
            (a, b) =>
                this.getTimestamp(a) -
                this.getTimestamp(b),
        );

        await ctx.editMessageText(
            [
                '🏸 Активні тренування',
                '',
                trainings.length
                    ? `Тренувань: ${trainings.length}`
                    : 'Активних тренувань немає',
            ].join('\n'),
            createActiveTrainingsKeyboard(trainings),
        );
    }

    private async showTraining(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        await ctx.editMessageText(
            this.renderTraining(training),
            createTrainingKeyboard(training),
        );
    }

    private renderTraining(
        training: Training,
    ): string {
        const places =
            training.participants.reduce(
                (sum, item) =>
                    sum + item.places,
                0,
            );

        return [
            `🏸 ${training.title}`,
            '',
            `📅 ${training.date}`,
            `🕐 ${training.startTime}–${training.endTime}`,
            '',
            `👥 ${places}/${training.placesLimit}`,
            `🕒 Очікування: ${training.waitlist.length}`,
            `🔻 Мінімум: ${training.minPlayers}`,
        ].join('\n');
    }

    private getId(
        callback: string,
        prefix: string,
    ): string {
        return callback.replace(prefix, '');
    }

    private getTimestamp(
        training: Training,
    ): number {
        return new Date(
            `${training.date}T${training.startTime}:00`,
        ).getTime();
    }
}