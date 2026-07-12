export type AdminRole = 'owner' | 'manager';

export type ClubAdmin = {
    telegramUserId: number;
    role: AdminRole;
};

export type ClubSettings = {
    clubId: string;
    title: string;

    chatId?: number;
    timezone: string;

    admins: ClubAdmin[];

    cancelCheckHoursBefore: number;
    cleanChatMode: boolean;

    createdAt: string;
    updatedAt: string;
};