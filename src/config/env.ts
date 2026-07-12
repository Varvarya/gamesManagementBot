export type EnvConfig = {
    botToken: string;
    dataDir: string;
    clubId: string;
    superAdminIds: number[];
};

export function loadEnv(): EnvConfig {
    const botToken = process.env.BOT_TOKEN?.trim();

    if (!botToken) {
        throw new Error(
            'BOT_TOKEN environment variable is required',
        );
    }

    const superAdminIds = (
        process.env.SUPER_ADMIN_IDS ?? ''
    )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number);

    if (
        superAdminIds.some(
            (telegramUserId) =>
                !Number.isInteger(telegramUserId),
        )
    ) {
        throw new Error(
            'SUPER_ADMIN_IDS must contain valid Telegram user IDs',
        );
    }

    return {
        botToken,
        dataDir:
            process.env.DATA_DIR?.trim() ||
            './data',
        clubId:
            process.env.CLUB_ID?.trim() ||
            'default',
        superAdminIds,
    };
}