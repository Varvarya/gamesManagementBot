import { Player } from './player.types';
import { PlayersRepository } from '../../storage/repositories/players.repository';
import { PLAYER_CSV_COLUMNS, escapeCsv } from './player-csv';

export class PlayerExportService {
    constructor(private readonly clubId: string, private readonly clubTitle: string, private readonly players: PlayersRepository) {}

    async csv(): Promise<string> {
        const rows = (await this.players.list()).sort((a, b) => a.displayName.localeCompare(b.displayName, 'uk')).map((player) => [
            player.displayName, player.telegramUserId, player.username, player.aliases.join('|'), player.isConfirmed, player.isActive,
        ].map(escapeCsv).join(','));
        return `\uFEFF${PLAYER_CSV_COLUMNS.join(',')}\n${rows.join('\n')}\n`;
    }

    async json(): Promise<{ schemaVersion: 1; clubId: string; clubTitle: string; exportedAt: string; players: Player[] }> {
        return { schemaVersion: 1, clubId: this.clubId, clubTitle: this.clubTitle, exportedAt: new Date().toISOString(), players: await this.players.list() };
    }

    template(): string { return `\uFEFF${PLAYER_CSV_COLUMNS.join(',')}\nМарія,123456789,maria,Маша|Марія✨,true,true\n`; }
}
