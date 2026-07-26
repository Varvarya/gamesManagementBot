export type ChatConfig = {
    id: number;
    name: string;
    enabled: boolean;
};

export type CreateChatInput = {
    id: number;
    name: string;
    enabled?: boolean;
};

export type UpdateChatInput = {
    name?: string;
    enabled?: boolean;
};