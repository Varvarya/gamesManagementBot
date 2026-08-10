import { RepositoriesContext } from '../../app/repositories.context';
import { ClubAdmin, ClubSettings } from './settings.types';
import { isTelegramUserClubAdmin } from './club-admin-authorization';

export type EditableSetting = 'title' | 'timezone';

export class SettingsService {
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
        if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) throw new Error('Некоректний Telegram user id');
        const settings = structuredClone(await this.get());
        if (isTelegramUserClubAdmin(settings.admins, telegramUserId)) throw new Error('Цей користувач уже є адміністратором');
        settings.admins.push({ telegramUserId, role });
        settings.updatedAt = new Date().toISOString();
        return this.repositories.settings.save(settings);
    }

    async removeAdmin(telegramUserId: number): Promise<ClubSettings> {
        const settings = structuredClone(await this.get());
        if (!isTelegramUserClubAdmin(settings.admins, telegramUserId)) throw new Error('Адміністратора не знайдено');
        if (settings.admins.length <= 1) throw new Error('Не можна видалити останнього адміністратора');
        settings.admins = settings.admins.filter((admin) => admin.telegramUserId !== telegramUserId);
        settings.updatedAt = new Date().toISOString();
        return this.repositories.settings.save(settings);
    }

    validateTimezone(value: string): void {
        try { new Intl.DateTimeFormat('uk-UA', { timeZone: value }).format(); }
        catch { throw new Error('Некоректний часовий пояс, наприклад Europe/Kyiv'); }
    }

    validateTime(value: string): void {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Час має бути у форматі HH:mm');
    }
}
