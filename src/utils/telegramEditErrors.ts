function message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isTelegramMessageNotModified(error: unknown): boolean {
    return message(error).includes('message is not modified');
}

export function isTelegramMessageUnavailable(error: unknown): boolean {
    const value = message(error);
    return value.includes('message to edit not found') || value.includes("message can't be edited") || value.includes('message can not be edited');
}
