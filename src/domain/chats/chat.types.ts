export type ChatConfig = {
    id: number;
    name: string;
    enabled: boolean;
    /** Last known Telegram access result. Undefined means not checked yet. */
    available?: boolean;
    validationWarning?: string;
    validatedAt?: string;
};

export type CreateChatInput = {
    id: number;
    name: string;
    enabled?: boolean;
    available?: boolean;
    validationWarning?: string;
    validatedAt?: string;
};

export type UpdateChatInput = {
    name?: string;
    enabled?: boolean;
    available?: boolean;
    validationWarning?: string;
    validatedAt?: string;
};
