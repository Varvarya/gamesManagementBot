import crypto from 'node:crypto';
import { RegistrationCommand } from '../../domain/trainings/registration-command.parser';

export const REGISTRATION_SELECTION_PREFIX = 'reg:t:';
export const REGISTRATION_SELECTION_CANCEL_PREFIX = 'reg:c:';

export type PendingRegistrationSelection = {
    requestId: string;
    token: string;
    clubId: string;
    chatId: number;
    telegramUser: { id: number; first_name?: string; username?: string };
    command: RegistrationCommand;
    candidateTrainingIds: string[];
    trainingId: string;
    createdAt: string;
    expiresAt: number;
};

export class PendingRegistrationSelectionStore {
    private readonly values = new Map<string, PendingRegistrationSelection>();
    constructor(private readonly ttlMs = 7 * 60_000) {}

    create(input: Omit<PendingRegistrationSelection, 'requestId' | 'token' | 'createdAt' | 'expiresAt' | 'trainingId'>): PendingRegistrationSelection[] {
        this.prune();
        const superseded = new Set<string>();
        for (const value of this.values.values()) {
            if (value.clubId === input.clubId && value.chatId === input.chatId && value.telegramUser.id === input.telegramUser.id) {
                superseded.add(value.requestId);
            }
        }
        for (const requestId of superseded) this.complete(requestId);
        const requestId = this.shortToken();
        const now = Date.now();
        return input.candidateTrainingIds.map((trainingId) => {
            const token = this.shortToken();
            const value: PendingRegistrationSelection = {
                ...input, requestId, token, trainingId, createdAt: new Date(now).toISOString(), expiresAt: now + this.ttlMs,
            };
            this.values.set(token, value);
            return value;
        });
    }

    get(callback: string): { status: 'active'; value: PendingRegistrationSelection } | { status: 'expired' | 'missing' } {
        const token = callback.startsWith(REGISTRATION_SELECTION_PREFIX)
            ? callback.slice(REGISTRATION_SELECTION_PREFIX.length)
            : callback.startsWith(REGISTRATION_SELECTION_CANCEL_PREFIX)
                ? callback.slice(REGISTRATION_SELECTION_CANCEL_PREFIX.length)
                : callback;
        const value = this.values.get(token);
        if (!value) return { status: 'missing' };
        if (value.expiresAt <= Date.now()) {
            this.complete(value.requestId);
            return { status: 'expired' };
        }
        return { status: 'active', value };
    }

    clubIdFor(callback: string): string | undefined {
        const result = this.get(callback);
        return result.status === 'active' ? result.value.clubId : undefined;
    }

    complete(requestId: string): void {
        for (const [token, value] of this.values) if (value.requestId === requestId) this.values.delete(token);
    }

    get size(): number { this.prune(); return this.values.size; }

    private prune(): void {
        const now = Date.now();
        for (const [token, value] of this.values) if (value.expiresAt <= now) this.values.delete(token);
    }

    private shortToken(): string { return crypto.randomBytes(6).toString('base64url'); }
}
