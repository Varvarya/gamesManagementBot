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
    createTrainingWeekKeyboard,
    createTrainingEditKeyboard,
} from '../keyboards/training.keyboard';
import { getZonedNow } from '../../../domain/templates/template-scheduler.service';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';
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
        private readonly cancellationScheduler?: TrainingCancellationScheduler,
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
            callback === AdminCallbacks.TrainingWeek ||
            callback.startsWith(AdminCallbacks.TrainingWeekPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingEditPrefix) ||
            callback.startsWith(AdminCallbacks.ArchiveMonthPrefix) ||
            callback.startsWith(AdminCallbacks.ArchivedTrainingPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingCancelConfirmPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingParticipantsPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingFinishPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingCancelPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingRefreshPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingRepublishPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingClosePrefix) ||
            callback.startsWith(AdminCallbacks.TrainingOpenPrefix) ||
            callback.startsWith(AdminCallbacks.TrainingPrefix)
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

        if (callback === AdminCallbacks.TrainingWeek || callback.startsWith(AdminCallbacks.TrainingWeekPrefix)) {
            const requested = callback.startsWith(AdminCallbacks.TrainingWeekPrefix) ? callback.slice(AdminCallbacks.TrainingWeekPrefix.length) : undefined;
            await this.showWeek(ctx, requested);
            return;
        }

        if (callback.startsWith(AdminCallbacks.TrainingEditPrefix)) {
            const training = await this.services.trainings.getRequired(callback.slice(AdminCallbacks.TrainingEditPrefix.length));
            if (ctx.from) this.services.adminFlow.start(ctx.from.id, 'idle', { trainingId: training.id });
            await this.services.adminUi.show(ctx, `✏️ Змінити тренування\n\n${training.title}\n${formatDate(training.date)} · ${formatTimeRange(training.startTime, training.endTime)}\n\nЗміни стосуються лише цього тренування.`, createTrainingEditKeyboard(training));
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

        if (callback.startsWith(AdminCallbacks.TrainingRepublishPrefix)) {
            const training = await this.publisher.republish(callback.slice(AdminCallbacks.TrainingRepublishPrefix.length));
            await this.showTraining(ctx, training.id);
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

            await this.showTraining(ctx, training.id);
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

            await this.showTraining(ctx, training.id);
            return;
        }

        await this.showTraining(
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
        const settings = await this.services.settings.get();
        const today = getZonedNow(new Date(), settings.timezone).date;
        const tomorrow = addDays(today, 1);
        const all = await this.services.repositories.trainings.list();
        const trainings = all.filter((training) => training.date >= today && training.date <= tomorrow && !['finished', 'archived'].includes(training.status));

        trainings.sort(compareTrainingStart);

        await this.services.adminUi.show(
            ctx,
            [
                '🏸 Тренування',
                '',
                trainings.length > 0 ? renderUpcomingGroups(trainings, today) : '🏸 Найближчих тренувань немає.',
            ].join('\n'),
            createActiveTrainingsKeyboard(
                trainings,
            ),
        );
    }

    private async showWeek(ctx: Context, requested?: string): Promise<void> {
        const settings = await this.services.settings.get();
        const today = getZonedNow(new Date(), settings.timezone).date;
        const weekStart = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : mondayOf(today);
        const end = addDays(weekStart, 6);
        const trainings = (await this.services.repositories.trainings.list()).filter((item) => item.date >= weekStart && item.date <= end && !['finished', 'archived'].includes(item.status)).sort(compareTrainingStart);
        const lines: string[] = ['📅 Цей тиждень', ''];
        let current = '';
        trainings.forEach((training, index) => { if (training.date !== current) { current = training.date; lines.push(formatDate(current)); } lines.push(`${index + 1}. ${getStatusIcon(training)} ${training.startTime} ${training.title} · ${countPlaces(training)}/${training.placesLimit}`); });
        if (!trainings.length) lines.push('Тренувань цього тижня немає.');
        await this.services.adminUi.show(ctx, lines.join('\n'), createTrainingWeekKeyboard(trainings, weekStart));
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

    async showTraining(
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
        this.cancellationScheduler?.cancel(changed.id);
        await this.showTraining(ctx, changed.id);
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

function countPlaces(training: Training): number { return training.participants.reduce((sum, entry) => sum + entry.places, 0); }
function getStatusIcon(training: Training): string { return training.status === 'open' ? '🟢' : training.status === 'closed' ? '🔒' : training.status === 'cancelled' ? '❌' : '⚪️'; }
function addDays(date: string, days: number): string { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function mondayOf(date: string): string { const value = new Date(`${date}T00:00:00Z`); const day = value.getUTCDay() || 7; return addDays(date, 1 - day); }
function renderUpcomingGroups(trainings: Training[], today: string): string { const tomorrow = addDays(today, 1); const groups = [{ title: 'Сьогодні', date: today }, { title: 'Завтра', date: tomorrow }]; let index = 0; return groups.flatMap((group) => { const rows = trainings.filter((item) => item.date === group.date).map((item) => `${++index}. ${getStatusIcon(item)} ${item.startTime}–${item.endTime} · ${item.title} · ${countPlaces(item)}/${item.placesLimit}`); return rows.length ? [group.title, ...rows, ''] : []; }).join('\n').trim(); }

export function compareTrainingStart(first: Training, second: Training): number {
    return new Date(`${first.date}T${first.startTime}:00`).getTime() -
        new Date(`${second.date}T${second.startTime}:00`).getTime();
}
