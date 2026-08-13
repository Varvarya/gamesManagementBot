import { TelegramImportSource, TelegramUserConnection } from '../../domain/telegram-import/telegram-user-connection.types';
import { BaseJsonRepository } from './baseJsonRepository';

export class TelegramUserConnectionRepository extends BaseJsonRepository<TelegramUserConnection> {
    async listByClub(clubId: string): Promise<TelegramUserConnection[]> { return (await this.list()).filter((item) => item.clubId === clubId); }
    async findByShortId(shortId: string): Promise<TelegramUserConnection | undefined> { return (await this.list()).find((item) => item.shortId === shortId); }
}

export class TelegramImportSourceRepository extends BaseJsonRepository<TelegramImportSource> {
    async listByClub(clubId: string): Promise<TelegramImportSource[]> { return (await this.list()).filter((item) => item.clubId === clubId); }
    async findByShortId(shortId: string): Promise<TelegramImportSource | undefined> { return (await this.list()).find((item) => item.shortId === shortId); }
}
