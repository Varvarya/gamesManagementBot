import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { Training } from '../../../domain/trainings/training.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import {
    createActiveTrainingsKeyboard,
    createTrainingCancelKeyboard,
    createTrainingKeyboard,
    createTrainingParticipantsKeyboard,
    createArchivedTrainingsKeyboard,
    createArchivedTrainingKeyboard,
} from '../keyboards/training.keyboard';
import {
    formatDate,
    formatTimeRange,
    isTrainingParticipantListTruncated,
    renderTrainingCard,
} from '../ui/admin-formatters';

export class AdminTrainingHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {
        this.services.adminUi.setTrainingCardRenderer(async (trainingId) => {
            const training = await this.services.trainings.getRequired(trainingId);
            const card = await this.renderResolvedCard(training);
            return { text: card.text, keyboard: training.status === 'archived' || training.status === 'finished' ? createArchivedTrainingKeyboard(training, card.truncated) : createTrainingKeyboard(training, card.truncated) };
        });
    }

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.ActiveTrainings ||
            callback === AdminCallbacks.ArchivedTrainings ||
            callback.startsWith(AdminCallbacks.ArchiveMonthPrefix) ||
            callback.startsWith(AdminCallbacks.ArchivedTrainingPrefix) ||
            callback.startsWith(
                AdminCallbacks.TrainingPrefix,
            ) ||
            callback.startsWith(
                AdminCallbacks.TrainingParticipantsPrefix,
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
            if (ctx.from) this.services.adminFlow.finish(ctx.from.id);
            await this.showList(ctx);
            return;
        }

        if (callback === AdminCallbacks.ArchivedTrainings) {
            await this.showArchive(ctx, new Date().toISOString().slice(0, 7));
            return;
        }

        if (callback.startsWith(AdminCallbacks.ArchiveMonthPrefix)) {
            await this.showArchive(ctx, callback.replace(AdminCallbacks.ArchiveMonthPrefix, ''));
            return;
        }

        if (callback.startsWith(AdminCallbacks.ArchivedTrainingPrefix)) {
            const training = await this.services.trainings.getRequired(callback.replace(AdminCallbacks.ArchivedTrainingPrefix, ''));
            if (training.status !== 'archived' && training.status !== 'finished') {
                await this.services.adminUi.replaceWithError(ctx, 'Це тренування не належить до архіву.', createArchivedTrainingsKeyboard([]));
                return;
            }
            const card = await this.renderResolvedCard(training, true);
            await this.services.adminUi.show(ctx, card.text, createArchivedTrainingKeyboard(training, card.truncated));
            return;
        }

        if (callback.startsWith(AdminCallbacks.TrainingParticipantsPrefix)) {
            const training = await this.services.trainings.getRequired(callback.replace(AdminCallbacks.TrainingParticipantsPrefix, ''));
            const card = await this.renderResolvedCard(training, true);
            await this.services.adminUi.show(ctx, card.text, createTrainingParticipantsKeyboard(training));
            return;
        }

        if (callback.startsWith(AdminCallbacks.TrainingFinishPrefix)) {
            const changed = await this.services.trainings.finish(callback.replace(AdminCallbacks.TrainingFinishPrefix, ''));
            const fresh = await this.services.trainings.getRequired(changed.id);
            const card = await this.renderResolvedCard(fresh);
            await this.services.adminUi.replaceWithSuccess(ctx, `Тренування завершено й перенесено до архіву.\n\n${card.text}`, createArchivedTrainingKeyboard(fresh, card.truncated));
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

            await this.showSuccess(ctx, trainingId, 'Оголошення тренування оновлено.');
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

            await this.showSuccess(ctx, training.id, 'Реєстрацію закрито.');
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

            await this.showSuccess(ctx, training.id, 'Реєстрацію знову відкрито.');
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
        const all = await this.services.repositories.trainings.list();
        const now = Date.now();
        const trainings = all.filter((training) => {
            const timestamp = this.timestamp(training);
            return timestamp >= now && (training.status === 'open' || training.status === 'closed');
        });

        trainings.sort(compareTrainingStart);

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

    private async showArchive(ctx: Context, month: string): Promise<void> {
        const trainings = await this.services.repositories.trainings.listArchived({ month });
        trainings.sort((first, second) => compareTrainingStart(second, first));
        const [year, monthNumber] = month.split('-').map(Number);
        const monthTitle = Number.isInteger(year) && monthNumber >= 1 && monthNumber <= 12
            ? new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, monthNumber - 1, 1)))
            : month;
        await this.services.adminUi.show(ctx, [
            '📦 Архів тренувань', '', `Місяць: ${monthTitle}`, '',
            trainings.length ? `Знайдено: ${trainings.length}` : 'У цьому місяці завершених тренувань немає.',
        ].join('\n'), createArchivedTrainingsKeyboard(trainings, month));
    }

    private async show(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        if (training.status === 'archived' || training.status === 'finished') {
            const card = await this.renderResolvedCard(training);
            await this.services.adminUi.show(ctx, card.text, createArchivedTrainingKeyboard(training, card.truncated));
            return;
        }
        const card = await this.renderResolvedCard(training);
        await this.services.adminUi.showTrainingCard(
            ctx,
            training.id,
            card.text,
            createTrainingKeyboard(training, card.truncated),
        );
    }

    private async showSuccess(ctx: Context, trainingId: string, message: string): Promise<void> {
        const training = await this.services.trainings.getRequired(trainingId);
        const card = await this.renderResolvedCard(training);
        await this.services.adminUi.replaceWithSuccess(ctx, `${message}\n\n${card.text}`, createTrainingKeyboard(training, card.truncated));
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
        const changed =
            await this.services.trainings.cancel(
                trainingId,
            );

        await this.showSuccess(ctx, changed.id, 'Тренування скасовано.');
    }

    private async renderResolvedCard(training: Training, showAll = false): Promise<{ text: string; truncated: boolean }> {
        const [players, chat] = await Promise.all([
            this.services.repositories.players.list(),
            this.services.chats.getById(training.chatId),
        ]);
        const names = new Map(players.map((player) => [player.id, player.displayName]));
        return {
            text: renderTrainingCard(training, { playerNames: names, chatName: chat?.name ?? 'Невідомий чат', showAll }),
            truncated: isTrainingParticipantListTruncated(training),
        };
    }

    private timestamp(
        training: Training,
    ): number {
        return new Date(
            `${training.date}T${training.startTime}`,
        ).getTime();
    }
}

export function compareTrainingStart(first: Training, second: Training): number {
    return new Date(`${first.date}T${first.startTime}:00`).getTime() -
        new Date(`${second.date}T${second.startTime}:00`).getTime();
}
