import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { createPlayerKeyboard } from '../keyboards/player.keyboard';
import { renderPlayerCard } from '../ui/admin-formatters';

export class PlayerFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandleCallback(
        callback: string,
    ): boolean {
        return (
            callback === AdminCallbacks.CreatePlayer ||
            (
                callback.startsWith(
                    AdminCallbacks.PlayerPrefix,
                ) &&
                callback.endsWith(':rename')
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
            callback ===
            AdminCallbacks.CreatePlayer
        ) {
            this.services.adminFlow.transition(
                adminId,
                'waiting_new_player_name',
            );

            await this.services.adminUi.show(
                ctx,
                [
                    '➕ Новий гравець',
                    '',
                    'Надішліть імʼя одним повідомленням',
                ].join('\n'),
                createFlowCancelKeyboard(
                    AdminCallbacks.Players,
                ),
            );
            return;
        }

        const playerId = callback
            .replace(
                AdminCallbacks.PlayerPrefix,
                '',
            )
            .replace(':rename', '');

        const player =
            await this.services.repositories.players.findById(
                playerId,
            );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        this.services.adminFlow.transition(
            adminId,
            'waiting_player_name',
            {
                playerId,
            },
        );

        await this.services.adminUi.show(
            ctx,
            [
                '✏️ Зміна імені',
                '',
                `Зараз: ${player.displayName}`,
                '',
                'Надішліть правильне імʼя',
            ].join('\n'),
            createFlowCancelKeyboard(
                `${AdminCallbacks.PlayerPrefix}${player.id}`,
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
            state === 'waiting_player_name' ||
            state === 'waiting_new_player_name'
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

        if (
            state ===
            'waiting_new_player_name'
        ) {
            const player =
                await this.services.players.createManual(
                    text,
                );

            this.services.adminFlow.reset(
                adminId,
            );

            await this.services.adminUi.replaceWithSuccess(
                ctx,
                renderPlayerCard(player),
                createPlayerKeyboard(player),
            );
            return;
        }

        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        if (!data.playerId) {
            throw new Error(
                'Player ID is missing',
            );
        }

        const player =
            await this.services.players.updateName(
                data.playerId,
                text,
            );

        await this.publisher.refreshMessagesForPlayer(
            player.id,
        );

        this.services.adminFlow.reset(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            renderPlayerCard(player),
            createPlayerKeyboard(player),
        );
    }
}