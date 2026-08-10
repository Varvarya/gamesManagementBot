import fs from 'node:fs/promises';
import path from 'node:path';
import { Club } from '../../domain/clubs/club.types';
import { RepositoriesContext } from '../../app/repositories.context';
import { JsonStorage } from '../jsonStorage';
import { createClubSlug } from '../clubSlug';
import { ClubSettings } from '../../domain/settings/settings.types';
import { createId } from '../../utils/ids';
import { Player } from '../../domain/players/player.types';
import { BaseJsonRepository } from './baseJsonRepository';
import { clubAdminTelegramId, isTelegramUserClubAdmin, StoredClubAdmin } from '../../domain/settings/club-admin-authorization';

export class ClubRepository {
    private readonly registry: BaseJsonRepository<Club>;
    constructor(private readonly dataDir: string, private readonly defaultTimezone = 'Europe/Kyiv') {
        this.registry = new BaseJsonRepository<Club>(path.join(dataDir, '_system', 'clubs.json'));
    }

    async findAll(): Promise<Club[]> {
        return (await this.registry.list()).map(normalizeRegistryClub).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    }

    async findById(id: string): Promise<Club | undefined> { return (await this.findAll()).find((club) => club.id === id); }
    async findByShortId(shortId: string): Promise<Club | undefined> { return (await this.findAll()).find((club) => club.shortId === shortId); }
    async findBySlug(slug: string): Promise<Club | undefined> { return (await this.findAll()).find((club) => club.slug === slug); }

    async create(input: { name: string; slug?: string; firstAdminTelegramId?: number }): Promise<Club> {
        const name = input.name.trim();
        if (!name) throw new Error('Назва клубу не може бути порожньою');
        const slug = input.slug ?? createClubSlug(name);
        if (await this.findBySlug(slug)) throw new Error('Клуб із такою назвою вже існує');
        const clubId = createId('club');
        const directory = path.resolve(this.dataDir, slug);
        if (path.dirname(directory) !== path.resolve(this.dataDir)) throw new Error('Некоректний slug клубу');
        const storage = new JsonStorage({ dataDir: this.dataDir, storageSlug: slug });
        await storage.ensureReady();
        const repositories = new RepositoriesContext(storage, this.defaultTimezone, { clubId, title: name, storageSlug: slug });
        await repositories.loadAll();
        if (input.firstAdminTelegramId) {
            const settings = await repositories.settings.get();
            settings.admins = [{ telegramUserId: input.firstAdminTelegramId, role: 'owner' }];
            settings.updatedAt = new Date().toISOString();
            await repositories.settings.save(settings);
        }
        const settings = await repositories.settings.get();
        const club = this.toClub(settings);
        await this.registry.save(club);
        return club;
    }

    async registerExisting(settings: ClubSettings): Promise<Club> {
        const existing = await this.findById(settings.clubId);
        if (existing) return existing;
        const club = this.toClub(settings);
        await this.registry.save(club);
        return club;
    }

    async delete(id: string): Promise<void> {
        const club = await this.findById(id);
        if (!club) throw new Error('Клуб не знайдено');
        const directory = path.resolve(this.dataDir, club.slug);
        if (path.dirname(directory) !== path.resolve(this.dataDir) || path.basename(directory) !== club.slug) throw new Error('Некоректний шлях клубу');
        await fs.rm(directory, { recursive: true, force: false });
        await this.registry.delete(id);
    }
    async backupAndDelete(id: string): Promise<string> {
        const club = await this.required(id);
        const source = path.resolve(this.dataDir, club.slug);
        const backup = path.join(this.dataDir, '_system', 'deleted-club-backups', `${club.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.cp(source, backup, { recursive: true, errorOnExist: true, force: false });
        if (!await isDirectoryPath(backup)) throw new Error('Не вдалося створити резервну копію клубу');
        await this.delete(id);
        return backup;
    }

    async disable(id: string): Promise<Club> { const club = await this.required(id); const now = new Date().toISOString(); return this.registry.save({ ...club, status: 'disabled', disabledAt: now, updatedAt: now }); }
    async enable(id: string): Promise<Club> { const club = await this.required(id); const now = new Date().toISOString(); return this.registry.save({ ...club, status: 'setup_required', disabledAt: undefined, updatedAt: now }); }
    async touchActivity(id: string, at = new Date().toISOString()): Promise<Club> { const club = await this.required(id); return this.registry.save({ ...club, lastActivityAt: at, updatedAt: at }); }
    async recordSuccessfulPublication(id: string, at = new Date().toISOString()): Promise<Club> { const club = await this.required(id); return this.registry.save({ ...club, lastActivityAt: at, lastSuccessfulPublicationAt: at, updatedAt: at }); }
    async recordSchedulerRestore(id: string, expected: number, restored: number, error?: string): Promise<Club> { const club = await this.required(id); return this.registry.save({ ...club, expectedSchedulerJobs: expected, restoredSchedulerJobs: restored, lastSchedulerError: error, updatedAt: new Date().toISOString() }); }
    async updateStatus(id: string, status: Club['status']): Promise<Club> { const club = await this.required(id); return this.registry.save({ ...club, status, updatedAt: new Date().toISOString() }); }

    async addAdmin(id: string, telegramUserId: number): Promise<Club> {
        if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) throw new Error('Некоректний Telegram ID');
        return this.updateAdmins(id, (settings) => {
            if (isTelegramUserClubAdmin(settings.admins, telegramUserId)) throw new Error('Користувач уже є адміністратором');
            settings.admins.push({ telegramUserId, role: 'admin' });
        });
    }

    async removeAdmin(id: string, telegramUserId: number): Promise<Club> {
        return this.updateAdmins(id, (settings) => {
            if (!isTelegramUserClubAdmin(settings.admins, telegramUserId)) throw new Error('Адміністратора не знайдено');
            if (settings.admins.length <= 1) throw new Error('Не можна видалити останнього адміністратора');
            const target = settings.admins.find((admin) => Number(admin.telegramUserId) === Number(telegramUserId));
            const owners = settings.admins.filter((admin) => admin.role === 'owner');
            if (target?.role === 'owner' && owners.length <= 1) {
                throw new Error('Не можна видалити останнього власника без призначення нового');
            }
            settings.admins = settings.admins.filter((admin) => admin.telegramUserId !== telegramUserId);
        });
    }

    async userIsAdmin(telegramUserId: number): Promise<boolean> { return (await this.findAdminClubs(telegramUserId)).length > 0; }
    async findAdminClubs(telegramUserId: number): Promise<Club[]> {
        const userId = Number(telegramUserId);
        if (!Number.isSafeInteger(userId) || userId <= 0) return [];
        const matches: Club[] = [];
        for (const club of await this.findAll()) {
            const context = await this.loadAuthorizationContext(club.id);
            if (isTelegramUserClubAdmin(context.admins, userId)) matches.push({ ...club, admins: context.admins });
        }
        return matches;
    }

    /** Loads authorization data from the repository belonging to the selected Club.id. */
    async loadAuthorizationContext(clubId: string): Promise<{ club?: Club; repositoryClubId?: string; admins: Club['admins']; adminTelegramIds: number[] }> {
        const club = await this.findById(clubId);
        if (!club) return { admins: [], adminTelegramIds: [] };
        const settings = await this.readSettings(path.join(this.dataDir, club.slug, 'settings.json'));
        const admins = normalizeAdmins((settings as (ClubSettings & { adminTelegramIds?: unknown }) | undefined)?.admins
            ?? (settings as (ClubSettings & { adminTelegramIds?: unknown }) | undefined)?.adminTelegramIds
            ?? club.admins);
        return { club, repositoryClubId: settings?.clubId, admins, adminTelegramIds: admins.map((admin) => admin.telegramUserId) };
    }
    async userBelongsToClub(telegramUserId: number): Promise<boolean> {
        return (await this.findMemberClubs(telegramUserId)).length > 0;
    }

    async findMemberClubs(telegramUserId: number): Promise<Club[]> {
        const matches: Club[] = [];
        for (const club of await this.findAll()) if (await this.userBelongsToClubId(telegramUserId, club.id)) matches.push(club);
        return matches;
    }

    async userBelongsToClubId(telegramUserId: number, clubId: string): Promise<boolean> {
        const club = await this.findById(clubId);
        if (!club) return false;
        try {
            const raw: unknown = JSON.parse(await fs.readFile(path.join(this.dataDir, club.slug, 'players.json'), 'utf8'));
            const players = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : [];
            return Array.isArray(players) && players.some((player) => player && typeof player === 'object' && (player as { telegramUserId?: number }).telegramUserId === telegramUserId);
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }

    async findUserTelegramId(query: string): Promise<number | undefined> {
        const normalized = query.trim().replace(/^@/, '').toLocaleLowerCase('uk');
        const numeric = Number(normalized);
        if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
        const matches: Player[] = [];
        for (const club of await this.findAll()) {
            try {
                const raw: unknown = JSON.parse(await fs.readFile(path.join(this.dataDir, club.slug, 'players.json'), 'utf8'));
                const players = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : [];
                if (Array.isArray(players)) matches.push(...players as Player[]);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const player = matches.find((item) => item.telegramUserId && item.username?.replace(/^@/, '').toLocaleLowerCase('uk') === normalized)
            ?? matches.find((item) => item.telegramUserId && item.displayName.toLocaleLowerCase('uk') === normalized);
        return player?.telegramUserId;
    }

    private async updateAdmins(id: string, update: (settings: ClubSettings) => void): Promise<Club> {
        const club = await this.findById(id);
        if (!club) throw new Error('Клуб не знайдено');
        const file = path.join(this.dataDir, club.slug, 'settings.json');
        const settings = await this.readSettings(file);
        if (!settings) throw new Error('Налаштування клубу не знайдено');
        update(settings);
        settings.updatedAt = new Date().toISOString();
        const storage = new JsonStorage({ dataDir: this.dataDir, storageSlug: club.slug });
        const repositories = new RepositoriesContext(storage, this.defaultTimezone, { clubId: settings.clubId, title: settings.title, storageSlug: settings.storageSlug });
        await repositories.settings.save(settings);
        const updated = { ...this.toClub(settings), ...(await this.findById(id)), admins: normalizeAdmins(settings.admins), updatedAt: settings.updatedAt };
        await this.registry.save(updated);
        return updated;
    }

    private toClub(settings: ClubSettings): Club { return { id: settings.clubId, shortId: createShortId(settings.clubId), name: settings.title, slug: settings.storageSlug, admins: normalizeAdmins((settings as ClubSettings & { admins?: unknown }).admins), status: 'setup_required', createdAt: settings.createdAt, updatedAt: settings.updatedAt, approvedAt: settings.createdAt }; }
    private async required(id: string): Promise<Club> { const club = await this.findById(id); if (!club) throw new Error('Клуб не знайдено'); return club; }
    private async readSettings(file: string): Promise<ClubSettings | undefined> {
        try {
            const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
            const value = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw;
            return value && typeof value === 'object' && typeof (value as ClubSettings).clubId === 'string' ? value as ClubSettings : undefined;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
}

function createShortId(id: string): string { return id.replace(/[^a-zA-Z0-9]/g, '').slice(-10) || createId().replace(/-/g, '').slice(0, 10); }
async function isDirectoryPath(value: string): Promise<boolean> { try { return (await fs.stat(value)).isDirectory(); } catch { return false; } }

function normalizeAdmins(value: unknown): Club['admins'] {
    if (!Array.isArray(value)) return [];
    const result: Club['admins'] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' && typeof entry !== 'string' && (!entry || typeof entry !== 'object')) continue;
        const telegramUserId = clubAdminTelegramId(entry as StoredClubAdmin);
        if (telegramUserId === undefined || isTelegramUserClubAdmin(result, telegramUserId)) continue;
        const rawRole = entry && typeof entry === 'object' ? (entry as { role?: unknown }).role : undefined;
        result.push({ telegramUserId, role: rawRole === 'owner' ? 'owner' : 'admin' });
    }
    return result;
}

function normalizeRegistryClub(value: Club): Club {
    const legacy = value as Club & { title?: string; adminTelegramIds?: unknown; admins?: unknown };
    return {
        ...value,
        shortId: value.shortId || createShortId(value.id),
        name: value.name || legacy.title || value.slug,
        admins: normalizeAdmins(legacy.admins ?? legacy.adminTelegramIds),
        status: value.status || 'setup_required',
        updatedAt: value.updatedAt || value.createdAt,
    };
}
