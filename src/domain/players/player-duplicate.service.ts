import { Player } from './player.types';
import { normalizePlayerValue } from './player-csv';

export type PlayerDuplicateCandidate = { playerIds: string[]; reason: 'same_telegram_id' | 'exact_name_or_alias' | 'possible_name_match'; confidence: 'blocking' | 'exact' | 'fuzzy' };

export class PlayerDuplicateService {
    find(players: Player[]): PlayerDuplicateCandidate[] {
        const results: PlayerDuplicateCandidate[] = [];
        const telegram = new Map<number, Player[]>();
        for (const player of players) if (player.telegramUserId !== undefined) telegram.set(player.telegramUserId, [...(telegram.get(player.telegramUserId) ?? []), player]);
        for (const group of telegram.values()) if (group.length > 1) results.push({ playerIds: group.map((player) => player.id), reason: 'same_telegram_id', confidence: 'blocking' });
        for (let first = 0; first < players.length; first++) for (let second = first + 1; second < players.length; second++) {
            const a = players[first]; const b = players[second];
            const aNames = [a.displayName, ...a.aliases].map(normalizePlayerValue);
            const bNames = [b.displayName, ...b.aliases].map(normalizePlayerValue);
            if (aNames.some((name) => bNames.includes(name))) {
                results.push({ playerIds: [a.id, b.id], reason: 'exact_name_or_alias', confidence: 'exact' });
                continue;
            }
            const distance = editDistance(normalizePlayerValue(a.displayName), normalizePlayerValue(b.displayName));
            const longest = Math.max(a.displayName.length, b.displayName.length);
            if (longest >= 5 && distance <= 2) results.push({ playerIds: [a.id, b.id], reason: 'possible_name_match', confidence: 'fuzzy' });
        }
        return deduplicate(results);
    }
}

function editDistance(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row++) {
        const current = [row];
        for (let column = 1; column <= b.length; column++) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1));
        previous.splice(0, previous.length, ...current);
    }
    return previous[b.length];
}

function deduplicate(values: PlayerDuplicateCandidate[]): PlayerDuplicateCandidate[] {
    const seen = new Set<string>();
    return values.filter((value) => { const key = [...value.playerIds].sort().join(':'); if (seen.has(key)) return false; seen.add(key); return true; });
}
