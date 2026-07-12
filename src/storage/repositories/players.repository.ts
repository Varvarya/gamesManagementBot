import { Player } from '../../domain/players/player.types';
import { BaseJsonRepository } from './baseJsonRepository';

export class PlayersRepository extends BaseJsonRepository<Player> {
    async findByTelegramId(telegramUserId: number): Promise<Player | undefined> {
        const players = await this.list();

        return players.find((player) => player.telegramUserId === telegramUserId);
    }

    async listUnconfirmed(): Promise<Player[]> {
        const players = await this.list();

        return players.filter((player) => !player.isConfirmed && player.isActive);
    }

    async searchByName(query: string): Promise<Player[]> {
        const normalizedQuery = query.trim().toLowerCase();

        if (!normalizedQuery) return [];

        const players = await this.list();

        return players.filter((player) => {
            const names = [
                player.displayName,
                player.telegramName,
                player.username,
                ...player.aliases,
            ]
                .filter(Boolean)
                .map((value) => String(value).toLowerCase());

            return names.some((name) => name.includes(normalizedQuery));
        });
    }
}