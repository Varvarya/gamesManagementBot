import { escapeCsv } from '../../domain/players/player-csv';
import { TelegramPlayerCandidate } from './telegram-player-candidate';

export const TELEGRAM_PLAYER_CSV_COLUMNS = [
    'displayName', 'telegramUserId', 'telegramUsername', 'aliases', 'confirmed', 'active', 'needsReview',
] as const;

export class TelegramPlayerCsvWriter {
    serialize(candidates: readonly TelegramPlayerCandidate[]): string {
        const rows = candidates.map((candidate) => [
            candidate.suggestedDisplayName,
            candidate.telegramUserId,
            candidate.telegramUsername,
            candidate.aliases.join('|'),
            true,
            true,
            candidate.needsReview,
        ].map(escapeCsv).join(','));
        return `\uFEFF${TELEGRAM_PLAYER_CSV_COLUMNS.join(',')}\n${rows.join('\n')}\n`;
    }
}
