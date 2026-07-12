import { Player } from './player.types';
import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import { RepositoriesContext } from '../../app/repositories.context';

export class PlayerService {
    constructor(
        private readonly repositories: RepositoriesContext,
    ) {}

    async findOrCreateByTelegramUser(user: {
        id: number;
        first_name?: string;
        username?: string;
    }): Promise<Player> {
        const existing = await this.repositories.players.findByTelegramId(user.id);

        if (existing) {
            let changed = false;

            if (existing.telegramName !== user.first_name) {
                existing.telegramName = user.first_name;
                changed = true;
            }

            if (existing.username !== user.username) {
                existing.username = user.username;
                changed = true;
            }

            if (changed) {
                existing.updatedAt = nowIso();
                await this.repositories.players.save(existing);
            }

            return existing;
        }

        const now = nowIso();

        const player: Player = {
            id: createId('player'),

            telegramUserId: user.id,

            displayName:
                user.first_name ||
                user.username ||
                `Player ${user.id}`,

            telegramName: user.first_name,
            username: user.username,

            aliases: [],
            isConfirmed: false,
            isActive: true,

            createdAt: now,
            updatedAt: now,
        };

        await this.repositories.players.save(player);

        return player;
    }

    async rename(
        playerId: string,
        displayName: string,
    ): Promise<Player> {
        const player = await this.repositories.players.findById(playerId);

        if (!player) {
            throw new Error(`Player ${playerId} not found`);
        }

        player.displayName = displayName.trim();
        player.updatedAt = nowIso();

        await this.repositories.players.save(player);

        return player;
    }

    async confirm(playerId: string): Promise<Player> {
        const player = await this.repositories.players.findById(playerId);

        if (!player) {
            throw new Error(`Player ${playerId} not found`);
        }

        player.isConfirmed = true;
        player.updatedAt = nowIso();

        await this.repositories.players.save(player);

        return player;
    }

    async addAlias(
        playerId: string,
        alias: string,
    ): Promise<Player> {
        const player = await this.repositories.players.findById(playerId);

        if (!player) {
            throw new Error(`Player ${playerId} not found`);
        }

        const value = alias.trim();

        if (
            value &&
            !player.aliases.includes(value)
        ) {
            player.aliases.push(value);
            player.updatedAt = nowIso();

            await this.repositories.players.save(player);
        }

        return player;
    }

    async deactivate(playerId: string): Promise<Player> {
        const player = await this.repositories.players.findById(playerId);

        if (!player) {
            throw new Error(`Player ${playerId} not found`);
        }

        player.isActive = false;
        player.updatedAt = nowIso();

        await this.repositories.players.save(player);

        return player;
    }

    async updateName(
        playerId: string,
        displayName: string,
    ): Promise<Player> {
        const player = await this.repositories.players.findById(
            playerId,
        );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        const normalizedName = displayName
            .trim()
            .replace(/\s+/g, ' ');

        if (
            normalizedName.length < 2 ||
            normalizedName.length > 100
        ) {
            throw new Error(
                'Invalid player display name',
            );
        }

        player.displayName = normalizedName;
        player.isConfirmed = true;
        player.updatedAt = nowIso();

        await this.repositories.players.save(player);

        return player;
    }

    async createManual(
        displayName: string,
    ): Promise<Player> {
        const normalizedName = displayName
            .trim()
            .replace(/\s+/g, ' ');

        if (
            normalizedName.length < 2 ||
            normalizedName.length > 100
        ) {
            throw new Error(
                'Invalid player display name',
            );
        }

        const existing =
            await this.repositories.players.searchByName(
                normalizedName,
            );

        const exactMatch = existing.find(
            (player) =>
                player.displayName.toLowerCase() ===
                normalizedName.toLowerCase(),
        );

        if (exactMatch) {
            throw new Error(
                `Player ${exactMatch.displayName} already exists`,
            );
        }

        const now = nowIso();

        const player: Player = {
            id: createId('player'),

            displayName: normalizedName,

            aliases: [],
            isConfirmed: true,
            isActive: true,

            createdAt: now,
            updatedAt: now,
        };

        return this.repositories.players.save(player);
    }
}