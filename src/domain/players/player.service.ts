import { Player } from './player.types';
import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import { RepositoriesContext } from '../../app/repositories.context';
import { logger } from '../../utils/logger';
import { createClubSlug } from '../../storage/clubSlug';

export class PlayerService {
    private mutationQueue: Promise<void> = Promise.resolve();
    constructor(
        private readonly repositories: RepositoriesContext,
    ) {}

    async findByTelegramId(telegramUserId: number): Promise<Player | undefined> {
        return this.repositories.players.findByTelegramId(telegramUserId);
    }

    async findOrCreateByTelegramUser(user: {
        id: number;
        first_name?: string;
        username?: string;
    }): Promise<Player> {
        return this.serialize(async () => {
        let existing = await this.repositories.players.findByTelegramId(user.id);

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
            source: 'telegram',

            createdAt: now,
            updatedAt: now,
        };

        await this.repositories.players.save(player);
        logger.info('player.created', { playerId: player.id, source: 'telegram', confirmed: false });

        return player;
        });
    }

    async findOrCreateByName(displayName: string): Promise<Player> {
        const normalized = this.normalizeName(displayName);
        if (normalized.length < 2 || normalized.length > 100) {
            throw new Error('Invalid player display name');
        }

        return this.serialize(async () => {
            const players = await this.repositories.players.list();
            const key = normalized.toLocaleLowerCase();
            const existing = players.find((player) => [
                player.displayName,
                player.telegramName,
                player.username,
                ...player.aliases,
            ].some((value) => value?.trim().toLocaleLowerCase() === key));

            if (existing) return existing;

            const now = nowIso();
            const player = await this.repositories.players.save({
                id: createId('player'),
                displayName: normalized,
                aliases: [],
                isConfirmed: false,
                isActive: true,
                createdAt: now,
                updatedAt: now,
            });
            logger.info('player.created', { playerId: player.id, source: 'name', confirmed: false });
            return player;
        });
    }

    async resolveByStrongName(name: string): Promise<Player | undefined> {
        const key = this.normalizeLookup(name);
        if (!key) return undefined;
        const matches = (await this.repositories.players.list()).filter((player) => player.isActive && [
            player.displayName, player.telegramName, player.username, ...player.aliases,
        ].some((value) => value && this.normalizeLookup(value) === key));
        if (matches.length > 1) throw new Error('AMBIGUOUS_PLAYER_NAME');
        return matches[0];
    }

    async resolveOrCreateTelegramGuest(displayName: string): Promise<Player> {
        const normalized = this.normalizeName(displayName);
        if (normalized.length < 2 || normalized.length > 100) throw new Error('INVALID_PLAYER_NAME');
        const existing = await this.resolveByStrongName(normalized);
        if (existing) return existing;
        return this.serialize(async () => {
            const raced = await this.resolveByStrongName(normalized);
            if (raced) return raced;
            const now = nowIso();
            return this.repositories.players.save({
                id: createId('player'), displayName: normalized, aliases: [], isConfirmed: false,
                isActive: true, source: 'telegram_guest', createdAt: now, updatedAt: now,
            });
        });
    }

    private normalizeName(value: string): string {
        return value.trim().replace(/\s+/g, ' ');
    }

    private normalizeLookup(value: string): string {
        return this.normalizeName(value).replace(/^@/, '').toLocaleLowerCase('uk');
    }

    private async serialize<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.mutationQueue;
        let release!: () => void;
        this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
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
        logger.info('player.renamed', { playerId });

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
        logger.info('player.confirmed', { playerId });

        return player;
    }

    async setConfirmed(playerId: string, isConfirmed: boolean): Promise<Player> {
        const player = await this.getRequired(playerId);
        player.isConfirmed = isConfirmed;
        player.updatedAt = nowIso();
        const saved = await this.repositories.players.save(player);
        logger.info('player.confirmation_changed', { playerId, confirmed: isConfirmed });
        return saved;
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
            logger.info('player.alias_added', { playerId });
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
        logger.info('player.activation_changed', { playerId, active: false });

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
        logger.info('player.renamed', { playerId, confirmed: true });

        return player;
    }

    async createManual(
        displayName: string,
        allowDuplicate = false,
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

        const key = normalizedName.toLocaleLowerCase();
        const exactMatch = existing.find((player) =>
            [player.displayName, player.telegramName, player.username, ...player.aliases]
                .some((value) => value?.trim().replace(/^@/, '').toLocaleLowerCase() === key.replace(/^@/, '')),
        );

        if (exactMatch && !allowDuplicate) {
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

        const saved = await this.repositories.players.save(player);
        logger.info('player.created', { playerId: saved.id, source: 'admin', confirmed: true });
        return saved;
    }

    async createUnconfirmedByAdmin(displayName: string): Promise<Player> {
        const normalizedName = this.normalizeName(displayName);
        if (normalizedName.length < 2 || normalizedName.length > 100) {
            throw new Error('Invalid player display name');
        }
        const now = nowIso();
        const player: Player = {
            id: createId('player'),
            displayName: normalizedName,
            aliases: [],
            isConfirmed: false,
            isActive: true,
            source: 'admin',
            createdAt: now,
            updatedAt: now,
        };
        const saved = await this.repositories.players.save(player);
        logger.info('player.created', { playerId: saved.id, source: 'admin', confirmed: false });
        return saved;
    }

    async search(query = '', limit = 10, options: { includeInactive?: boolean; unconfirmedOnly?: boolean } = {}): Promise<Player[]> {
        const key = this.normalizeSearchValue(query);
        const players = await this.repositories.players.list();
        const score = (player: Player): number => {
            const display = this.normalizeSearchValue(player.displayName);
            const values = [player.telegramName, player.username, ...player.aliases]
                .filter((value): value is string => Boolean(value))
                .map((value) => this.normalizeSearchValue(value));
            if (!key) return player.isConfirmed ? 10 : 0;
            return Math.min(
                this.matchScore(key, display, 0),
                ...values.map((value) => this.matchScore(key, value, 0.2)),
            );
        };
        return players
            .map((player) => ({ player, score: score(player) }))
            .filter((item) => Number.isFinite(item.score) && (!options.unconfirmedOnly || !item.player.isConfirmed) && (item.player.isActive || options.includeInactive || item.score < 1))
            .sort((a, b) => a.score - b.score || Number(b.player.isActive) - Number(a.player.isActive) || Number(a.player.isConfirmed) - Number(b.player.isConfirmed) || a.player.displayName.localeCompare(b.player.displayName, 'uk'))
            .slice(0, Math.max(0, Math.min(10, limit)))
            .map((item) => item.player);
    }

    private normalizeSearchValue(value: string): string {
        return createClubSlug(value.replace(/^@/, '')).replace(/-/g, ' ');
    }

    async findLikelyDuplicates(name: string, excludePlayerId?: string): Promise<Player[]> {
        return (await this.search(name, 10, { includeInactive: true }))
            .filter((player) => player.id !== excludePlayerId);
    }

    private matchScore(query: string, candidate: string, fieldPenalty: number): number {
        if (candidate === query) return fieldPenalty;
        if (candidate.startsWith(query)) return 1 + fieldPenalty;
        if (candidate.includes(query)) return 2 + fieldPenalty;
        const distance = this.editDistance(query, candidate);
        const longest = Math.max(query.length, candidate.length);
        const similarity = longest === 0 ? 1 : 1 - distance / longest;
        const allowed = query.length <= 3 ? distance <= 1 : distance <= 2 || similarity >= 0.6;
        return allowed ? 3 + (1 - similarity) * 4 + fieldPenalty : Number.POSITIVE_INFINITY;
    }

    private editDistance(first: string, second: string): number {
        const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
        for (let row = 1; row <= first.length; row += 1) {
            const current = [row];
            for (let column = 1; column <= second.length; column += 1) {
                current[column] = Math.min(
                    current[column - 1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1),
                );
            }
            previous.splice(0, previous.length, ...current);
        }
        return previous[second.length];
    }

    async setActive(playerId: string, isActive: boolean): Promise<Player> {
        const player = await this.getRequired(playerId);
        player.isActive = isActive;
        player.updatedAt = nowIso();
        const saved = await this.repositories.players.save(player);
        logger.info('player.activation_changed', { playerId, active: isActive });
        return saved;
    }

    async deleteMistakenPlayer(playerId: string): Promise<void> {
        const player = await this.getRequired(playerId);
        if (player.isConfirmed) throw new Error('Підтвердженого гравця не можна видалити');
        const trainings = await this.repositories.trainings.list();
        const hasRegistrations = trainings.some((training) =>
            [...training.participants, ...training.waitlist].some((entry) => entry.playerId === playerId),
        );
        if (hasRegistrations) throw new Error('Гравець має реєстрації. Обʼєднайте його з іншим профілем або деактивуйте.');
        await this.repositories.players.delete(playerId);
        logger.info('player.deleted_as_mistake', { playerId });
    }

    async merge(sourceId: string, targetId: string): Promise<Player> {
        if (sourceId === targetId) throw new Error('Не можна обʼєднати гравця із самим собою');
        return this.serialize(async () => {
            const source = await this.getRequired(sourceId);
            const target = await this.getRequired(targetId);
            const trainings = await this.repositories.trainings.list();

            for (const training of trainings) {
                const sourceMain = training.participants.find((x) => x.playerId === sourceId);
                const sourceWait = training.waitlist.find((x) => x.playerId === sourceId);
                const targetMain = training.participants.find((x) => x.playerId === targetId);
                const targetWait = training.waitlist.find((x) => x.playerId === targetId);
                if (!sourceMain && !sourceWait) continue;

                training.participants = training.participants.filter((x) => x.playerId !== sourceId && x.playerId !== targetId);
                training.waitlist = training.waitlist.filter((x) => x.playerId !== sourceId && x.playerId !== targetId);
                const chosen = targetMain ?? sourceMain ?? targetWait ?? sourceWait!;
                chosen.playerId = targetId;
                chosen.telegramUserId = target.telegramUserId ?? source.telegramUserId;
                chosen.updatedAt = nowIso();
                if (targetMain || sourceMain) {
                    chosen.status = 'active';
                    training.participants.push(chosen);
                } else {
                    chosen.status = 'waiting';
                    training.waitlist.push(chosen);
                }
                await this.repositories.trainings.save(training);
            }

            const aliases = new Set([...target.aliases, ...source.aliases, source.displayName]);
            aliases.delete(target.displayName);
            target.aliases = [...aliases];
            target.telegramUserId ??= source.telegramUserId;
            target.telegramName ??= source.telegramName;
            target.username ??= source.username;
            target.isConfirmed = target.isConfirmed || source.isConfirmed;
            target.updatedAt = nowIso();
            await this.repositories.players.save(target);
            source.isActive = false;
            source.aliases = [...new Set([...source.aliases, `merged:${target.id}`])];
            source.updatedAt = nowIso();
            await this.repositories.players.save(source);
            logger.info('player.merged', { sourcePlayerId: sourceId, targetPlayerId: targetId });
            return target;
        });
    }

    private async getRequired(playerId: string): Promise<Player> {
        const player = await this.repositories.players.findById(playerId);
        if (!player) throw new Error(`Player ${playerId} not found`);
        return player;
    }
}
