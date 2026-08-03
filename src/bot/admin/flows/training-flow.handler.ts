import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowNavigationKeyboard } from '../keyboards/flow.keyboard';
import {
    createTrainingKeyboard,
    createTrainingPlayerSearchKeyboard,
    createArchivedTrainingsKeyboard,
} from '../keyboards/training.keyboard';
import { isTrainingParticipantListTruncated, renderTrainingCard } from '../ui/admin-formatters';
import { Training } from '../../../domain/trainings/training.types';
import { AdminFlowState } from './admin-flow.types';

type TrainingPlayerAction =
    | 'add'
    | 'remove';

export class TrainingFlowHandler {
    readonly textStates: readonly AdminFlowState[] = ['waiting_training_add_player', 'waiting_training_remove_player', 'waiting_training_archive_search'];
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandleCallback(
        callback: string,
    ): boolean {
        return (
            callback === AdminCallbacks.ArchiveSearch ||
            callback.startsWith(
                AdminCallbacks.TrainingAddPlayerPrefix,
            ) ||
            callback.startsWith(
                AdminCallbacks.TrainingRemovePlayerPrefix,
            ) ||
            callback.startsWith(
                AdminCallbacks.TrainingSelectAddPlayerPrefix,
            ) ||
            callback.startsWith(
                AdminCallbacks.TrainingSelectRemovePlayerPrefix,
            )
        );
    }

    async handleCallback(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        if (callback === AdminCallbacks.ArchiveSearch) {
            const searchQuery = this.services.adminFlow.getData(adminId).searchQuery ?? '';
            this.services.adminFlow.transition(adminId, 'waiting_training_archive_search', { searchQuery });
            await this.services.adminUi.show(ctx, ['🔎 Пошук в архіві', '', 'Надішліть частину назви або дату.', 'Наприклад: Вечірнє або 2026-08-04', searchQuery ? `Поточний запит: «${searchQuery}»` : ''].filter(Boolean).join('\n'), createFlowNavigationKeyboard(AdminCallbacks.ArchivedTrainings, AdminCallbacks.ActiveTrainings));
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingSelectAddPlayerPrefix,
            )
        ) {
            await this.selectPlayer(
                ctx,
                adminId,
                callback,
                'add',
            );
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingSelectRemovePlayerPrefix,
            )
        ) {
            await this.selectPlayer(
                ctx,
                adminId,
                callback,
                'remove',
            );
            return;
        }

        const action: TrainingPlayerAction =
            callback.startsWith(
                AdminCallbacks.TrainingAddPlayerPrefix,
            )
                ? 'add'
                : 'remove';

        const prefix =
            action === 'add'
                ? AdminCallbacks.TrainingAddPlayerPrefix
                : AdminCallbacks.TrainingRemovePlayerPrefix;

        const trainingId =
            callback.replace(prefix, '');

        this.services.adminFlow.transition(
            adminId,
            action === 'add'
                ? 'waiting_training_add_player'
                : 'waiting_training_remove_player',
            {
                trainingId,
            },
        );

        await this.services.adminUi.show(
            ctx,
            [
                action === 'add'
                    ? '➕ Додати гравця'
                    : '➖ Прибрати гравця',
                '',
                'Надішліть імʼя або його частину',
            ].join('\n'),
            createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${trainingId}`, AdminCallbacks.ActiveTrainings),
        );
    }

    canHandleText(
        adminId: number,
    ): boolean {
        const state =
            this.services.adminFlow.getState(
                adminId,
            );

        return (
            state ===
            'waiting_training_add_player' ||
            state ===
            'waiting_training_remove_player' ||
            state === 'waiting_training_archive_search'
        );
    }

    async handleText(
        ctx: Context,
        text: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        if (this.services.adminFlow.getState(adminId) === 'waiting_training_archive_search') {
            this.services.adminFlow.setData(adminId, { searchQuery: text });
            const trainings = await this.services.repositories.trainings.listArchived({ query: text });
            trainings.sort((first, second) => second.date.localeCompare(first.date) || second.startTime.localeCompare(first.startTime));
            await this.services.adminUi.show(ctx, [
                '🔎 Результати пошуку', '',
                trainings.length ? `Знайдено: ${trainings.length}` : 'Нічого не знайдено. Спробуйте іншу назву або дату.',
            ].join('\n'), createArchivedTrainingsKeyboard(trainings.slice(0, 20)));
            return;
        }

        if (!data.trainingId) {
            throw new Error(
                'Training ID is missing',
            );
        }

        const action: TrainingPlayerAction =
            this.services.adminFlow.getState(
                adminId,
            ) ===
            'waiting_training_add_player'
                ? 'add'
                : 'remove';

        let players = await this.services.players.search(text, 10);

        if (action === 'add') {
            players = players.filter(
                (player) => player.isActive,
            );
        } else {
            const training =
                await this.services.trainings.getRequired(
                    data.trainingId,
                );
            const playerIds = new Set([
                ...training.participants.map(
                    (item) => item.playerId,
                ),
                ...training.waitlist.map(
                    (item) => item.playerId,
                ),
            ]);

            players = players.filter(
                (player) =>
                    playerIds.has(player.id),
            );
        }

        if (players.length === 0) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'Гравців за таким запитом не знайдено',
                createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${data.trainingId}`, AdminCallbacks.ActiveTrainings),
            );
            return;
        }

        if (players.length === 1) {
            const player = players[0];

            try {
                await this.apply(data.trainingId, player.id, action);
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, `${this.errorMessage(error)}\n\nВведіть інше імʼя або поверніться назад.`, createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${data.trainingId}`, AdminCallbacks.ActiveTrainings));
                return;
            }

            const training =
                await this.services.trainings.getRequired(
                    data.trainingId,
                );
            const card = await this.renderResolvedCard(training);

            this.services.adminFlow.reset(
                adminId,
            );

            await this.services.adminUi.replaceWithSuccess(
                ctx,
                [
                    action === 'add'
                        ? `${player.displayName} додано`
                        : `${player.displayName} прибрано`,
                    '',
                    card.text,
                ].join('\n'),
                createTrainingKeyboard(training, card.truncated),
            );
            return;
        }

        await this.services.adminUi.show(
            ctx,
            [
                '🔎 Знайдено кілька гравців',
                '',
                'Оберіть потрібного',
            ].join('\n'),
            createTrainingPlayerSearchKeyboard(
                data.trainingId,
                players.slice(0, 20),
                action,
            ),
        );
    }

    private async selectPlayer(
        ctx: Context,
        adminId: number,
        callback: string,
        action: TrainingPlayerAction,
    ): Promise<void> {
        const prefix =
            action === 'add'
                ? AdminCallbacks.TrainingSelectAddPlayerPrefix
                : AdminCallbacks.TrainingSelectRemovePlayerPrefix;

        const payload = callback.replace(prefix, '');
        const flowTrainingId = this.services.adminFlow.getData(adminId).trainingId;
        // Accept legacy combined callbacks safely while new keyboards keep data under 64 bytes.
        const separator = payload.indexOf(':');
        const trainingId = separator >= 0 ? payload.slice(0, separator) : flowTrainingId;
        const playerId = separator >= 0 ? payload.slice(separator + 1) : payload;

        if (!trainingId || !playerId) {
            throw new Error(
                'Invalid training player callback',
            );
        }

        try {
            await this.apply(trainingId, playerId, action);
        } catch (error) {
            await this.services.adminUi.replaceWithError(ctx, `${this.errorMessage(error)}\n\nОберіть іншого гравця або поверніться назад.`, createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${trainingId}`, AdminCallbacks.ActiveTrainings));
            return;
        }

        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );
        const card = await this.renderResolvedCard(training);

        this.services.adminFlow.reset(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            card.text,
            createTrainingKeyboard(training, card.truncated),
        );
    }

    private async apply(
        trainingId: string,
        playerId: string,
        action: TrainingPlayerAction,
    ): Promise<void> {
        if (action === 'add') {
            const player =
                await this.services.repositories.players.findById(
                    playerId,
                );

            if (!player) {
                throw new Error(
                    `Player ${playerId} not found`,
                );
            }

                const training =
                await this.services.trainingParticipants.addOrUpdateParticipant({
                    trainingId,
                    playerId,
                    displayName: player.displayName,
                    telegramUserId:
                    player.telegramUserId,
                    places: 1,
                    source: 'admin',
                    overrideState: true,
                });

            return;
        }

        const training =
            await this.services.trainingParticipants.removeParticipantCompletely({
                trainingId,
                playerId,
                overrideState: true,
            });

    }

    private errorMessage(error: unknown): string {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('already registered')) return 'Гравець уже є в основному списку або листі очікування';
        if (message.includes('not open')) return 'Реєстрацію на це тренування закрито';
        return message || 'Не вдалося змінити список учасників';
    }

    private async renderResolvedCard(training: Training): Promise<{ text: string; truncated: boolean }> {
        const [players, chat] = await Promise.all([
            this.services.repositories.players.list(),
            this.services.chats.getById(training.chatId),
        ]);
        return {
            text: renderTrainingCard(training, { playerNames: new Map(players.map((player) => [player.id, player.displayName])), chatName: chat?.name ?? 'Невідомий чат' }),
            truncated: isTrainingParticipantListTruncated(training),
        };
    }
}
