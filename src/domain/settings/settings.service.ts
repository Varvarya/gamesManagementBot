import { RepositoriesContext } from '../../app/repositories.context';
import { ClubAdmin, ClubSettings } from './settings.types';
import { isTelegramUserClubAdmin } from './club-admin-authorization';

export type EditableSetting = 'title' | 'timezone';

export class SettingsService {
    private mutationQueue: Promise<void> = Promise.resolve();
    constructor(private readonly repositories: RepositoriesContext) {}

    async get(): Promise<ClubSettings> {
        return this.repositories.settings.get();
    }

    async update(field: EditableSetting, raw: string): Promise<ClubSettings> {
        const settings = await this.get();
        const next = structuredClone(settings);
        if (field === 'title') {
            const title = raw.trim();
            if (!title) throw new Error('Назва клубу не може бути порожньою');
            next.title = title;
        } else if (field === 'timezone') {
            this.validateTimezone(raw.trim());
            next.timezone = raw.trim();
        }
        next.updatedAt = new Date().toISOString();
        return this.repositories.settings.save(next);
    }

    async toggleCleanChat(): Promise<ClubSettings> {
        const settings = structuredClone(await this.get());
        settings.cleanChatMode = !settings.cleanChatMode;
        settings.updatedAt = new Date().toISOString();
        return this.repositories.settings.save(settings);
    }

    async addAdmin(telegramUserId: number, role: ClubAdmin['role'] = 'admin'): Promise<ClubSettings> {
        return this.serialize(async () => {
            const userId = this.requireTelegramId(telegramUserId);
            const settings = structuredClone(await this.get());
            if (isTelegramUserClubAdmin(settings.admins, userId)) throw new Error('Цей користувач уже є адміністратором клубу.');
            settings.admins.push({ telegramUserId: userId, role });
            return this.saveRoleChange(settings);
        });
    }

    async removeAdmin(telegramUserId: number): Promise<ClubSettings> {
        return this.serialize(async () => {
            const userId = this.requireTelegramId(telegramUserId);
            const settings = structuredClone(await this.get());
            const target = settings.admins.find((admin) => Number(admin.telegramUserId) === userId);
            if (!target) throw new Error('Адміністратора не знайдено.');
            if (settings.admins.length <= 1) throw new Error('Не можна видалити єдиного адміністратора.');
            if (target.role === 'owner' && settings.admins.filter((admin) => admin.role === 'owner').length <= 1) {
                throw new Error('Не можна видалити останнього owner.');
            }
            settings.admins = settings.admins.filter((admin) => Number(admin.telegramUserId) !== userId);
            return this.saveRoleChange(settings);
        });
    }

    async transferOwnership(currentOwnerTelegramUserId: number, newOwnerTelegramUserId: number): Promise<ClubSettings> {
        return this.serialize(async () => {
            const fromId = this.requireTelegramId(currentOwnerTelegramUserId);
            const toId = this.requireTelegramId(newOwnerTelegramUserId);
            if (fromId === toId) throw new Error('Новий owner уже має цю роль.');
            const settings = structuredClone(await this.get());
            const currentOwner = settings.admins.find((admin) => Number(admin.telegramUserId) === fromId);
            const newOwner = settings.admins.find((admin) => Number(admin.telegramUserId) === toId);
            if (currentOwner?.role !== 'owner') throw new Error('Поточний owner більше не має цієї ролі. Оновіть список.');
            if (!newOwner || newOwner.role !== 'admin') throw new Error('Передати owner можна лише чинному адміністратору.');
            settings.admins = settings.admins.map((admin) => Number(admin.telegramUserId) === fromId
                ? { ...admin, role: 'admin' }
                : Number(admin.telegramUserId) === toId ? { ...admin, role: 'owner' } : admin);
            return this.saveRoleChange(settings);
        });
    }

    private async saveRoleChange(settings: ClubSettings): Promise<ClubSettings> {
        if (!settings.admins.some((admin) => admin.role === 'owner')) throw new Error('Клуб повинен мати хоча б одного owner.');
        settings.updatedAt = new Date().toISOString();
        return this.repositories.settings.save(settings);
    }

    private requireTelegramId(value: number | string): number {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Некоректний Telegram ID.');
        return id;
    }

    private async serialize<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.mutationQueue;
        let release!: () => void;
        this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); } finally { release(); }
    }

    validateTimezone(value: string): void {
        try { new Intl.DateTimeFormat('uk-UA', { timeZone: value }).format(); }
        catch { throw new Error('Некоректний часовий пояс, наприклад Europe/Kyiv'); }
    }

    validateTime(value: string): void {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Час має бути у форматі HH:mm');
    }
}
