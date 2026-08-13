export type TelegramConnectionStatus = 'connected' | 'expired' | 'reauth_required' | 'disabled';

export type TelegramUserConnection = {
    id: string;
    shortId: string;
    clubId: string;
    telegramUserId: number;
    displayName: string;
    username?: string;
    sessionStorageKey: string;
    connectedAt: string;
    lastValidatedAt: string;
    status: TelegramConnectionStatus;
};

export type TelegramImportSource = {
    id: string;
    shortId: string;
    clubId: string;
    connectionId: string;
    telegramChatId: string;
    title: string;
    addedBy: number;
    createdAt: string;
};
