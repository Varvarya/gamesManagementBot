import { Api, TelegramClient } from 'teleproto';
import { TelegramContact, TelegramParticipant } from './telegram-player-candidate';

export type TelegramGroupDialog = { id: string; title: string; entity: Api.TypeEntityLike };
export type ParticipantLoadResult = { participants: TelegramParticipant[]; partial: boolean; reportedTotal?: number };

export class TelegramParticipantLoader {
    constructor(private readonly client: TelegramClient) {}

    async listGroups(): Promise<TelegramGroupDialog[]> {
        const dialogs = await this.client.getDialogs({ limit: undefined });
        return dialogs.filter((dialog) => dialog.isGroup && dialog.entity).map((dialog) => ({
            id: dialog.id?.toString() ?? '',
            title: dialog.title || dialog.name || 'Без назви',
            entity: dialog.entity!,
        })).sort((a, b) => a.title.localeCompare(b.title, 'uk'));
    }

    async load(group: TelegramGroupDialog): Promise<ParticipantLoadResult> {
        const users = await this.client.getParticipants(group.entity, { limit: undefined, showTotal: true });
        const participants = users.flatMap((user): TelegramParticipant[] => user instanceof Api.User ? [{
            telegramUserId: safeTelegramId(user.id.toString()),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username?.replace(/^@/, ''),
            phone: user.phone,
            bot: user.bot,
            deleted: user.deleted,
            self: user.self,
        }] : []);
        return { participants, reportedTotal: users.total, partial: typeof users.total === 'number' && users.total > users.length };
    }
}

export class TelegramContactsLoader {
    constructor(private readonly client: TelegramClient) {}

    async load(): Promise<TelegramContact[]> {
        const result = await this.client.invoke(new Api.contacts.GetContacts({ hash: 0 as never }));
        if (!(result instanceof Api.contacts.Contacts)) return [];
        return result.users.flatMap((user): TelegramContact[] => user instanceof Api.User ? [{
            userId: safeTelegramId(user.id.toString()), firstName: user.firstName, lastName: user.lastName, phone: user.phone,
        }] : []);
    }
}

function safeTelegramId(value: string): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Telegram повернув непідтримуваний user ID: ${value}`);
    return id;
}
