export type AdminRole = 'owner' | 'admin';

export type ClubAdmin = {
    telegramUserId: number;
    role: AdminRole;
};

export type ClubSettings = {
    clubId: string;
    title: string;
    storageSlug: string;

    chatId?: number;
    timezone: string;
    admins: ClubAdmin[];
    cleanChatMode: boolean;

    createdAt: string;
    updatedAt: string;
    lastBackupAt?: string;
    latestError?: string;
};
