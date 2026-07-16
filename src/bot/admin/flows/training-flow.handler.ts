import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createTrainingPlayerSearchKeyboard } from '../keyboards/training.keyboard';

type TrainingPlayerAction =
    | 'add'
    | 'remove';

export class TrainingFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandleCallback(callback: string): boolean {
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

        if (
            callback.startsWith(
                AdminCallbacks.TrainingAddPlayerPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingAddPlayerPrefix,
                '',
            );

            await this.startPlayerSearch(
                ctx,
                adminId,
                trainingId,
                'add',
            );

            return;
        }

        const trainingId = callback.replace(
            AdminCallbacks.TrainingRemovePlayerPrefix,
            '',
        );

        await this.startPlayerSearch(
            ctx,
            adminId,
            trainingId,
            'remove',
        );
    }

    canHandleText(adminId: number): boolean {
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

        const state =
            this.services.adminFlow.getState(
                adminId,
            );

        const action: TrainingPlayerAction =
            state ===
            'waiting_training_add_player'
                ? 'add'
                : 'remove';

        await this.searchPlayers(
            ctx,
            adminId,
            text,
            action,
        );
    }

    private async startPlayerSearch(
        ctx: Context,
        adminId: number,
        trainingId: string,
        action: TrainingPlayerAction,
    ): Promise<void> {
        await this.services.trainings.getRequired(
            trainingId,
        );

        this.services.adminFlow.transition(
            adminId,
            action === 'add'
                ? 'waiting_training_add_player'
                : 'waiting_training_remove_player',
            {
                trainingId,
            },
        );

        await ctx.editMessageText(
            [
                action === 'add'
                    ? '➕ Додати гравця'
                    : '➖ Прибрати гравця',
                '',
                'Введіть імʼя або частину імені',
            ].join('\n'),
        );
    }

    private async searchPlayers(
        ctx: Context,
        adminId: number,
        query: string,
        action: TrainingPlayerAction,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        if (!data.trainingId) {
            throw new Error(
                'Training ID is missing',
            );
        }

        let players =
            await this.services.repositories.players.searchByName(
                query,
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
                    (participant) =>
                        participant.playerId,
                ),
                ...training.waitlist.map(
                    (participant) =>
                        participant.playerId,
                ),
            ]);

            players = players.filter(
                (player) =>
                    playerIds.has(player.id),
            );
        }

        if (players.length === 0) {
            await ctx.reply(
                '❌ Гравців не знайдено',
            );

            return;
        }

        if (players.length === 1) {
            const player = players[0];

            await this.applyPlayerAction(
                data.trainingId,
                player.id,
                action,
            );

            this.services.adminFlow.reset(
                adminId,
            );

            await ctx.reply(
                action === 'add'
                    ? `✅ ${player.displayName} додано`
                    : `✅ ${player.displayName} прибрано`,
            );

            return;
        }

        await ctx.reply(
            'Оберіть гравця',
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

        const value = callback.replace(
            prefix,
            '',
        );

        const [trainingId, playerId] =
            value.split(':');

        if (!trainingId || !playerId) {
            throw new Error(
                'Invalid training player callback',
            );
        }

        await this.applyPlayerAction(
            trainingId,
            playerId,
            action,
        );

        this.services.adminFlow.reset(
            adminId,
        );

        await ctx.editMessageText(
            '✅ Готово',
        );
    }

    private async applyPlayerAction(
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