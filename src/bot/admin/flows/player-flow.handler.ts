import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export class PlayerFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandleCallback(callback: string): boolean {
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

        if (callback === AdminCallbacks.CreatePlayer) {
            this.services.adminFlow.transition(
                adminId,
                'waiting_new_player_name',
            );

            await ctx.editMessageText(
                [
                    '➕ Новий гравець',
                    '',
                    'Введіть імʼя гравця',
                ].join('\n'),
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

        await ctx.editMessageText(
            [
                '✏️ Імʼя гравця',
                '',
                `Зараз: ${player.displayName}`,
                '',
                'Введіть правильне імʼя',
            ].join('\n'),
        );
    }

    canHandleText(adminId: number): boolean {
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

        if (state === 'waiting_new_player_name') {
            await this.createPlayer(
                ctx,
                adminId,
                text,
            );

            return;
        }

        if (state === 'waiting_player_name') {
            await this.renamePlayer(
                ctx,
                adminId,
                text,
            );
        }
    }

    private async createPlayer(
        ctx: Context,
        adminId: number,
        displayName: string,
    ): Promise<void> {
        const player =
            await this.services.players.createManual(
                displayName,
            );

        this.services.adminFlow.reset(
            adminId,
        );

        await ctx.reply(
            [
                '✅ Гравця створено',
                '',
                `👤 ${player.displayName}`,
            ].join('\n'),
        );
    }

    private async renamePlayer(
        ctx: Context,
        adminId: number,
        displayName: string,
    ): Promise<void> {
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
                displayName,
            );

        await this.publisher.refreshMessagesForPlayer(
            player.id,
        );

        this.services.adminFlow.reset(
            adminId,
        );

        await ctx.reply(
            [
                '✅ Гравця оновлено',
                '',
                `👤 ${player.displayName}`,
            ].join('\n'),
        );
    }
}