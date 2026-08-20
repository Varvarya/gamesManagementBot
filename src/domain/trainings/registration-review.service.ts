import crypto from 'node:crypto';
import { Markup, Telegram } from 'telegraf';
import { JsonStorage } from '../../storage/jsonStorage';
import { logger } from '../../utils/logger';
import { RegistrationCommand } from './registration-command.parser';
import { Training } from './training.types';
import { ClubAdmin } from '../settings/settings.types';

export const REGISTRATION_REVIEW_PREFIX = 'rr:';
export function registrationReviewRecipients(admins: readonly ClubAdmin[]): number[] { return [...new Set(admins.filter((item) => item.role === 'admin').map((item) => Number(item.telegramUserId)))]; }
export type PendingRegistrationReview = {
    id: string; token: string; clubId: string; sourceChatId: number; sourceMessageId: number; sourceText: string;
    telegramUser: { id: number; first_name?: string; username?: string }; parsedCommand: RegistrationCommand;
    candidateTrainingIds: string[]; suggestedTrainingId?: string; reason: 'TIME_NEAR_MATCH' | 'MULTIPLE_NEAR_MATCHES';
    status: 'pending' | 'resolved' | 'expired'; resolution?: 'accepted' | 'rejected'; resolvedTrainingId?: string;
    resolvedByTelegramUserId?: number; resolvedByName?: string; createdAt: string; expiresAt: number;
    adminMessages: Array<{ telegramUserId: number; chatId: number; messageId: number }>;
};

export class RegistrationReviewService {
    private queue: Promise<void> = Promise.resolve();
    private readonly key = 'pending-registration-reviews';
    constructor(private readonly storage: JsonStorage, private readonly telegram: Telegram, private readonly ttlMs = 12 * 60 * 60_000) {}

    async createOrGet(input: Omit<PendingRegistrationReview, 'id' | 'token' | 'status' | 'createdAt' | 'expiresAt' | 'adminMessages'>, admins: number[], trainings: Training[]): Promise<PendingRegistrationReview> {
        return this.serial(async () => {
            const values = await this.read();
            const existing = values.find((item) => item.clubId === input.clubId && item.sourceChatId === input.sourceChatId && item.sourceMessageId === input.sourceMessageId);
            if (existing) return existing;
            const now = Date.now();
            const review: PendingRegistrationReview = { ...input, id: crypto.randomUUID(), token: crypto.randomBytes(6).toString('base64url'), status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: now + this.ttlMs, adminMessages: [] };
            await this.write([...values, review]);
            for (const telegramUserId of [...new Set(admins)]) {
                try {
                    const message = await this.telegram.sendMessage(telegramUserId, this.pendingText(review, trainings), this.pendingKeyboard(review, trainings));
                    review.adminMessages.push({ telegramUserId, chatId: message.chat.id, messageId: message.message_id });
                } catch (error) { logger.warn('registration_review.delivery_failed', { clubId: review.clubId, reviewId: review.id, telegramUserId, error }); }
            }
            await this.replace(review);
            if (!review.adminMessages.length) logger.warn('registration_review.no_reachable_admins', { clubId: review.clubId, reviewId: review.id });
            return review;
        });
    }

    async findByCallback(callback: string): Promise<PendingRegistrationReview | undefined> {
        const token = callback.split(':')[2];
        return (await this.read()).find((item) => item.token === token);
    }
    async findBySource(clubId: string, chatId: number, messageId: number): Promise<PendingRegistrationReview | undefined> {
        return (await this.read()).find((item) => item.clubId === clubId && item.sourceChatId === chatId && item.sourceMessageId === messageId);
    }

    async listPending(clubId: string): Promise<PendingRegistrationReview[]> { return (await this.read()).filter((item) => item.clubId === clubId && item.status === 'pending' && item.expiresAt > Date.now()); }

    async showOtherTrainings(review: PendingRegistrationReview, chatId: number, messageId: number, trainings: Training[]): Promise<void> {
        if (review.status !== 'pending' || review.expiresAt <= Date.now()) return;
        const rows = trainings.map((training, index) => [Markup.button.callback(`${training.startTime}–${training.endTime} · ${training.title}`, `${REGISTRATION_REVIEW_PREFIX}t:${review.token}:${index}`)]);
        rows.push([Markup.button.callback('❌ Не записувати', `${REGISTRATION_REVIEW_PREFIX}n:${review.token}`)]);
        await this.telegram.editMessageText(chatId, messageId, undefined, 'Оберіть тренування:', Markup.inlineKeyboard(rows)).catch(() => undefined);
    }

    async resolve(reviewId: string, admin: { id: number; name: string }, decision: { type: 'reject' } | { type: 'accept'; trainingId: string }, execute: (review: PendingRegistrationReview, trainingId: string) => Promise<void>): Promise<'resolved' | 'already_resolved' | 'expired'> {
        return this.serial(async () => {
            const values = await this.read(); const review = values.find((item) => item.id === reviewId);
            if (!review || review.status !== 'pending') return 'already_resolved';
            if (review.expiresAt <= Date.now()) { review.status = 'expired'; await this.write(values); await this.sync(review); return 'expired'; }
            if (decision.type === 'accept') await execute(review, decision.trainingId);
            review.status = 'resolved'; review.resolution = decision.type === 'accept' ? 'accepted' : 'rejected'; review.resolvedTrainingId = decision.type === 'accept' ? decision.trainingId : undefined;
            review.resolvedByTelegramUserId = admin.id; review.resolvedByName = admin.name;
            await this.write(values); await this.sync(review); return 'resolved';
        });
    }

    private pendingText(review: PendingRegistrationReview, trainings: Training[]): string {
        const suggested = trainings.find((item) => item.id === review.suggestedTrainingId);
        const player = review.telegramUser.first_name ?? review.telegramUser.username ?? String(review.telegramUser.id);
        return ['⚠️ Потрібне підтвердження запису', '', 'Повідомлення:', `«${review.sourceText}»`, '', 'Гравець:', player, '', suggested ? `Ймовірно:\n${suggested.startTime}–${suggested.endTime} · ${suggested.title}` : 'Час неоднозначний.', '', `${review.parsedCommand.operation === 'add' ? 'Додати' : 'Зняти'}: ${review.parsedCommand.count} місця`].join('\n');
    }

    private pendingKeyboard(review: PendingRegistrationReview, trainings: Training[]) {
        const rows = []; const suggested = trainings.find((item) => item.id === review.suggestedTrainingId);
        if (suggested) rows.push([Markup.button.callback(`✅ Так, на ${suggested.startTime}`, `${REGISTRATION_REVIEW_PREFIX}y:${review.token}`)]);
        rows.push([Markup.button.callback('🔎 Обрати інше тренування', `${REGISTRATION_REVIEW_PREFIX}o:${review.token}`)]);
        rows.push([Markup.button.callback('❌ Не записувати', `${REGISTRATION_REVIEW_PREFIX}n:${review.token}`)]);
        return Markup.inlineKeyboard(rows);
    }

    private async sync(review: PendingRegistrationReview): Promise<void> {
        const text = review.status === 'expired' ? '⌛ Запит на підтвердження прострочено.' : `✅ Вирішено\n\n${review.resolution === 'accepted' ? 'Запис підтверджено.' : 'Запис відхилено.'}\n\nВирішив(ла): ${review.resolvedByName ?? review.resolvedByTelegramUserId}`;
        await Promise.allSettled(review.adminMessages.map((item) => this.telegram.editMessageText(item.chatId, item.messageId, undefined, text)));
    }

    private async read(): Promise<PendingRegistrationReview[]> { return this.storage.read(this.key, []); }
    private async write(values: PendingRegistrationReview[]): Promise<void> { await this.storage.write(this.key, values.filter((item) => item.expiresAt > Date.now() - 30 * 24 * 60 * 60_000)); }
    private async replace(review: PendingRegistrationReview): Promise<void> { const values = await this.read(); const index = values.findIndex((item) => item.id === review.id); if (index >= 0) values[index] = review; await this.write(values); }
    private async serial<T>(action: () => Promise<T>): Promise<T> { const previous = this.queue; let release!: () => void; this.queue = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await action(); } finally { release(); } }
}
