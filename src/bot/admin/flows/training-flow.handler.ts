import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import {
    createTrainingKeyboard,
    createTrainingPlayerSearchKeyboard,
} from '../keyboards/training.keyboard';
import { renderTrainingCard } from '../ui/admin-formatters';

type TrainingPlayerAction =
    | 'add'
    | 'remove';

export class TrainingFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandleCallback(
        callback: string,
    ): boolean {
        return (
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
            createFlowCancelKeyboard(
                `${AdminCallbacks.TrainingPrefix}${trainingId}`,
            ),
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
            'waiting_training_remove_player'
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

        let players =
            await this.services.repositories.players.searchByName(
                text,
            );

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
                createFlowCancelKeyboard(
                    `${AdminCallbacks.TrainingPrefix}${data.trainingId}`,
                ),
            );
            return;
        }

        if (players.length === 1) {
            const player = players[0];

            await this.apply(
                data.trainingId,
                player.id,
                action,
            );

            const training =
                await this.services.trainings.getRequired(
                    data.trainingId,
                );

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
                    renderTrainingCard(training),
                ].join('\n'),
                createTrainingKeyboard(training),
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

        const [trainingId, playerId] =
            callback
                .replace(prefix, '')
                .split(':');

        if (!trainingId || !playerId) {
            throw new Error(
                'Invalid training player callback',
            );
        }

        await this.apply(
            trainingId,
            playerId,
            action,
        );

        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        this.services.adminFlow.reset(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            renderTrainingCard(training),
            createTrainingKeyboard(training),
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
                    telegramUserId:
                    player.telegramUserId,
                    places: 1,
                    source: 'admin',
                });

            await this.publisher.refreshMessage(
                training.id,
            );

            return;
        }

        const training =
            await this.services.trainingParticipants.removeParticipantCompletely({
                trainingId,
                playerId,
            });

        await this.publisher.refreshMessage(
            training.id,
        );
    }
}