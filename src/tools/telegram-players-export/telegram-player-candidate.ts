export type TelegramParticipant = {
    telegramUserId: number;
    firstName?: string;
    lastName?: string;
    username?: string;
    phone?: string;
    bot?: boolean;
    deleted?: boolean;
    self?: boolean;
};

export type TelegramContact = {
    userId: number;
    firstName?: string;
    lastName?: string;
    phone?: string;
};

export type TelegramPlayerCandidate = {
    telegramUserId: number;
    telegramFirstName?: string;
    telegramLastName?: string;
    telegramUsername?: string;
    telegramDisplayName: string;
    contactFirstName?: string;
    contactLastName?: string;
    contactDisplayName?: string;
    suggestedDisplayName: string;
    aliases: string[];
    isContact: boolean;
    needsReview: boolean;
};

export type CandidateBuildResult = {
    candidates: TelegramPlayerCandidate[];
    receivedCount: number;
    botCount: number;
    deletedCount: number;
    duplicateCount: number;
};

export class TelegramPlayerCandidateBuilder {
    build(participants: readonly TelegramParticipant[], contacts: readonly TelegramContact[]): CandidateBuildResult {
        const contactsById = new Map(contacts.map((contact) => [contact.userId, contact]));
        const unique = new Map<number, TelegramParticipant>();
        let botCount = 0;
        let deletedCount = 0;
        let duplicateCount = 0;
        for (const participant of participants) {
            if (participant.bot) { botCount++; continue; }
            if (participant.deleted) { deletedCount++; continue; }
            if (unique.has(participant.telegramUserId)) { duplicateCount++; continue; }
            unique.set(participant.telegramUserId, participant);
        }
        const candidates = [...unique.values()].map((participant): TelegramPlayerCandidate => {
            const contact = contactsById.get(participant.telegramUserId);
            const telegramDisplayName = displayName(participant.firstName, participant.lastName);
            const contactDisplayName = contact ? displayName(contact.firstName, contact.lastName) : '';
            const suggestedDisplayName = contactDisplayName || telegramDisplayName;
            const aliases = telegramDisplayName && normalize(telegramDisplayName) !== normalize(suggestedDisplayName)
                ? [telegramDisplayName]
                : [];
            return {
                telegramUserId: participant.telegramUserId,
                telegramFirstName: participant.firstName,
                telegramLastName: participant.lastName,
                telegramUsername: participant.username?.replace(/^@/, '') || undefined,
                telegramDisplayName,
                contactFirstName: contact?.firstName,
                contactLastName: contact?.lastName,
                contactDisplayName: contactDisplayName || undefined,
                suggestedDisplayName,
                aliases,
                isContact: Boolean(contact),
                needsReview: isSuspiciousName(suggestedDisplayName),
            };
        }).sort((a, b) => Number(b.needsReview) - Number(a.needsReview)
            || a.suggestedDisplayName.localeCompare(b.suggestedDisplayName, 'uk')
            || a.telegramUserId - b.telegramUserId);
        return { candidates, receivedCount: participants.length, botCount, deletedCount, duplicateCount };
    }
}

export function isSuspiciousName(value: string): boolean {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized || !/\p{L}/u.test(normalized)) return true;
    const letters = normalized.match(/\p{L}/gu)?.join('') ?? '';
    return letters.length === 1;
}

function displayName(firstName?: string, lastName?: string): string {
    return [firstName, lastName].filter(Boolean).join(' ').trim().replace(/\s+/g, ' ');
}

function normalize(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk');
}
