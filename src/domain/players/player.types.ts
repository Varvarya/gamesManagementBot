export type PlayerId = string;

export type Player = {
    id: PlayerId;

    telegramUserId?: number;

    displayName: string;
    telegramName?: string;
    username?: string;

    aliases: string[];
    isConfirmed: boolean;
    isActive: boolean;

    createdAt: string;
    updatedAt: string;
};