import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowNavigationKeyboard } from '../keyboards/flow.keyboard';
import {
    createTrainingKeyboard,
    createTrainingPlayerSearchKeyboard,
    createArchivedTrainingsKeyboard,
    createUnknownTrainingPlayerKeyboard,
    createNewTrainingPlayerPreviewKeyboard,
    createTrainingPlayerDuplicateKeyboard,
} from '../keyboards/training.keyboard';
import { formatDate, formatTimeRange, isTrainingParticipantListTruncated, renderTrainingCard } from '../ui/admin-formatters';
import { Training } from '../../../domain/trainings/training.types';
import { AdminFlowState } from './admin-flow.types';
import { validateReservedPlaces } from '../../../domain/trainings/reserved-places';

type TrainingPlayerAction =
    | 'add'
    | 'remove';

export class TrainingFlowHandler {
    readonly textStates: readonly AdminFlowState[] = ['waiting_training_add_player', 'waiting_training_remove_player', 'waiting_training_reservation_places', 'waiting_training_new_player_name', 'waiting_training_new_player_places', 'waiting_training_new_player_confirmation', 'waiting_training_archive_search'];
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
            ) ||
            callback === AdminCallbacks.TrainingNewPlayerPreview ||
            callback === AdminCallbacks.TrainingNewPlayerEdit ||
            callback === AdminCallbacks.TrainingNewPlayerSearchAgain ||
            callback === AdminCallbacks.TrainingNewPlayerPlaces ||
            callback === AdminCallbacks.TrainingNewPlayerConfirm ||
            callback === AdminCallbacks.TrainingNewPlayerCreateAnyway ||
            callback === AdminCallbacks.TrainingNewPlayerCancel
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

        if (callback === AdminCallbacks.TrainingNewPlayerCancel) {
            const trainingId = this.services.adminFlow.getData(adminId).trainingId;
            if (!trainingId) throw new Error('Training ID is missing');
            this.services.adminFlow.reset(adminId);
            await this.showTrainingCard(ctx, trainingId);
            return;
        }
        if (callback === AdminCallbacks.TrainingNewPlayerEdit) {
            this.services.adminFlow.transition(adminId, 'waiting_training_new_player_name');
            await this.services.adminUi.show(ctx, '✏️ Надішліть ім’я нового гравця.', createFlowNavigationKeyboard(AdminCallbacks.TrainingNewPlayerCancel, AdminCallbacks.ActiveTrainings));
            return;
        }
        if (callback === AdminCallbacks.TrainingNewPlayerSearchAgain) {
            this.services.adminFlow.transition(adminId, 'waiting_training_add_player', { pendingPlayerName: undefined });
            await this.services.adminUi.show(ctx, '🔎 Надішліть ім’я або його частину.', createFlowNavigationKeyboard(AdminCallbacks.TrainingNewPlayerCancel, AdminCallbacks.ActiveTrainings));
            return;
        }
        if (callback === AdminCallbacks.TrainingNewPlayerPlaces) {
            this.services.adminFlow.transition(adminId, 'waiting_training_new_player_places');
            await this.services.adminUi.show(ctx, '👥 Надішліть кількість місць від 1 до 4.', createFlowNavigationKeyboard(AdminCallbacks.TrainingNewPlayerCancel, AdminCallbacks.ActiveTrainings));
            return;
        }
        if (callback === AdminCallbacks.TrainingNewPlayerPreview) {
            await this.showNewPlayerPreview(ctx, adminId, true);
            return;
        }
        if (callback === AdminCallbacks.TrainingNewPlayerConfirm) {
            if (await this.showDuplicatesIfAny(ctx, adminId)) return;
            await this.createNewPlayerAndRegister(ctx, adminId);
            return;
        }
        if (callback === AdminCallbacks.TrainingNewPlayerCreateAnyway) {
            await this.createNewPlayerAndRegister(ctx, adminId);
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
            state === 'waiting_training_reservation_places' ||
            state === 'waiting_training_new_player_name' ||
            state === 'waiting_training_new_player_places' ||
            state === 'waiting_training_new_player_confirmation' ||
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

        const state = this.services.adminFlow.getState(adminId);
        if (state === 'waiting_training_new_player_confirmation') {
            await this.services.adminUi.notice(ctx, 'Скористайтеся кнопками під попереднім переглядом.');
            return;
        }
        if (state === 'waiting_training_new_player_name') {
            const name = text.trim().replace(/\s+/g, ' ');
            if (name.length < 2 || name.length > 100) {
                await this.services.adminUi.replaceWithError(ctx, 'Ім’я має містити від 2 до 100 символів. Надішліть інше ім’я.', createFlowNavigationKeyboard(AdminCallbacks.TrainingNewPlayerCancel, AdminCallbacks.ActiveTrainings));
                return;
            }
            this.services.adminFlow.setData(adminId, { pendingPlayerName: name });
            await this.showNewPlayerPreview(ctx, adminId, true);
            return;
        }
        if (state === 'waiting_training_new_player_places') {
            try {
                const places = Number(text.trim());
                validateReservedPlaces(places);
                this.services.adminFlow.setData(adminId, { newTrainingPlayerPlaces: places });
                await this.showNewPlayerPreview(ctx, adminId, false);
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, `${this.errorMessage(error)}\n\nНадішліть число від 1 до 4.`, createFlowNavigationKeyboard(AdminCallbacks.TrainingNewPlayerCancel, AdminCallbacks.ActiveTrainings));
            }
            return;
        }

        if (state === 'waiting_training_reservation_places') {
            const places = Number(text.trim());
            try {
                validateReservedPlaces(places);
                if (!data.trainingId || !data.playerId) throw new Error('Дані вибору застаріли');
                const action = data.reservationAction ?? 'add';
                await this.apply(data.trainingId, data.playerId, action, places);
                await this.showCompleted(ctx, adminId, data.trainingId);
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, `${this.errorMessage(error)}\n\nНадішліть число від 1 до 4.`, createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${data.trainingId}`, AdminCallbacks.ActiveTrainings));
            }
            return;
        }

        if (state === 'waiting_training_archive_search') {
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

        let players = await this.services.players.search(text, 10, { includeInactive: true });

        if (action === 'remove') {
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
            if (action === 'remove') {
                await this.services.adminUi.replaceWithError(ctx, 'Гравців за таким запитом не знайдено', createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${data.trainingId}`, AdminCallbacks.ActiveTrainings));
                return;
            }
            const name = text.trim().replace(/\s+/g, ' ');
            this.services.adminFlow.transition(adminId, 'waiting_training_new_player_confirmation', { pendingPlayerName: name, newTrainingPlayerPlaces: 1 });
            await this.services.adminUi.show(ctx, `🔎 Гравця «${name}» не знайдено.\n\nДодати його як нового гравця?`, createUnknownTrainingPlayerKeyboard());
            return;
        }

        if (players.length === 1) {
            const player = players[0];

            await this.askReservedPlaces(ctx, adminId, data.trainingId, player.id, player.displayName, action);
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

        const player = await this.services.repositories.players.findById(playerId);
        if (!player) throw new Error(`Player ${playerId} not found`);
        await this.askReservedPlaces(ctx, adminId, trainingId, player.id, player.displayName, action);
    }

    private async apply(
        trainingId: string,
        playerId: string,
        action: TrainingPlayerAction,
        places = 1,
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
                    places,
                    source: 'admin',
                    overrideState: true,
                });

            return;
        }

        const training =
            await this.services.trainingParticipants.removeParticipant({
                trainingId,
                playerId,
                requestedPlacesToRemove: places,
                overrideState: true,
            });

    }

    private async askReservedPlaces(ctx: Context, adminId: number, trainingId: string, playerId: string, playerName: string, action: TrainingPlayerAction): Promise<void> {
        this.services.adminFlow.transition(adminId, 'waiting_training_reservation_places', { trainingId, playerId, reservationAction: action });
        await this.services.adminUi.show(ctx, `${action === 'add' ? '➕' : '➖'} ${playerName}\n\nСкільки місць ${action === 'add' ? 'зарезервувати' : 'скасувати'}? Надішліть число від 1 до 4.`, createFlowNavigationKeyboard(`${AdminCallbacks.TrainingPrefix}${trainingId}`, AdminCallbacks.ActiveTrainings));
    }

    private async showCompleted(ctx: Context, adminId: number, trainingId: string): Promise<void> {
        await this.publisher.refreshMessage(trainingId);
        const training = await this.services.trainings.getRequired(trainingId);
        const card = await this.renderResolvedCard(training);
        this.services.adminFlow.reset(adminId);
        await this.services.adminUi.showTrainingCard(ctx, training.id, card.text, createTrainingKeyboard(training, card.truncated));
    }

    private async showNewPlayerPreview(ctx: Context, adminId: number, checkDuplicates: boolean): Promise<void> {
        const data = this.services.adminFlow.getData(adminId);
        if (!data.trainingId || !data.pendingPlayerName) throw new Error('New player flow data is missing');
        if (checkDuplicates && await this.showDuplicatesIfAny(ctx, adminId)) return;
        const training = await this.services.trainings.getRequired(data.trainingId);
        const places = data.newTrainingPlayerPlaces ?? 1;
        this.services.adminFlow.transition(adminId, 'waiting_training_new_player_confirmation', { newTrainingPlayerPlaces: places });
        await this.services.adminUi.show(ctx, [
            '👤 Новий гравець', '', 'Ім’я:', data.pendingPlayerName, '', 'Тренування:', training.title,
            `${formatDate(training.date)}, ${formatTimeRange(training.startTime, training.endTime)}`, '', 'Кількість місць:', String(places),
        ].join('\n'), createNewTrainingPlayerPreviewKeyboard());
    }

    private async showDuplicatesIfAny(ctx: Context, adminId: number): Promise<boolean> {
        const data = this.services.adminFlow.getData(adminId);
        if (!data.pendingPlayerName) throw new Error('New player name is missing');
        const duplicates = await this.services.players.findLikelyDuplicates(data.pendingPlayerName);
        if (!duplicates.length) return false;
        await this.services.adminUi.show(ctx, ['Можливо, це вже наявний гравець:', '', ...duplicates.slice(0, 10).map((player, index) => `${index + 1}. ${player.displayName}`)].join('\n'), createTrainingPlayerDuplicateKeyboard(duplicates));
        return true;
    }

    private async createNewPlayerAndRegister(ctx: Context, adminId: number): Promise<void> {
        const data = this.services.adminFlow.getData(adminId);
        if (!data.trainingId || !data.pendingPlayerName) throw new Error('New player flow data is missing');
        try {
            await this.services.trainingPlayerCreation.createPlayerAndAddToTraining({
                clubId: this.services.repositories.clubId,
                trainingId: data.trainingId,
                displayName: data.pendingPlayerName,
                places: data.newTrainingPlayerPlaces ?? 1,
                createdByTelegramId: adminId,
            });
            await this.showCompleted(ctx, adminId, data.trainingId);
        } catch (error) {
            await this.services.adminUi.replaceWithError(ctx, this.errorMessage(error), createNewTrainingPlayerPreviewKeyboard());
        }
    }

    private async showTrainingCard(ctx: Context, trainingId: string): Promise<void> {
        const training = await this.services.trainings.getRequired(trainingId);
        const card = await this.renderResolvedCard(training);
        await this.services.adminUi.showTrainingCard(ctx, training.id, card.text, createTrainingKeyboard(training, card.truncated));
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
