export type StoredClubAdmin = number | string | { telegramUserId?: unknown; id?: unknown; role?: unknown };

export function clubAdminTelegramId(admin: StoredClubAdmin): number | undefined {
    const rawId = typeof admin === 'number' || typeof admin === 'string' ? admin : admin.telegramUserId ?? admin.id;
    const telegramUserId = Number(rawId);
    return Number.isSafeInteger(telegramUserId) && telegramUserId > 0 ? telegramUserId : undefined;
}

export function isTelegramUserClubAdmin(admins: unknown, telegramUserId: number | string): boolean {
    const userId = Number(telegramUserId);
    if (!Array.isArray(admins) || !Number.isSafeInteger(userId) || userId <= 0) return false;
    return admins.some((admin: unknown) => {
        if (typeof admin !== 'number' && typeof admin !== 'string' && (!admin || typeof admin !== 'object')) return false;
        if (clubAdminTelegramId(admin as StoredClubAdmin) !== userId) return false;
        if (typeof admin === 'number' || typeof admin === 'string') return true;
        const role = (admin as { role?: unknown }).role;
        return role === 'owner' || role === 'admin' || role === undefined;
    });
}

export function isClubAdmin(club: { admins?: unknown }, telegramUserId: number | string): boolean {
    return isTelegramUserClubAdmin(club.admins, telegramUserId);
}
