import { ScheduleExceptionsRepository } from '../../storage/repositories/schedule-exceptions.repository';
import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import { SaveScheduleExceptionInput, ScheduleException } from './schedule-exception.types';

export class ScheduleExceptionService {
    private mutationQueue: Promise<void> = Promise.resolve();
    private onChanged?: (exception: ScheduleException | undefined, previous?: ScheduleException) => Promise<void>;
    constructor(private readonly repository: ScheduleExceptionsRepository, private readonly clubId: string) {}
    async list(): Promise<ScheduleException[]> { return (await this.repository.listByClubId(this.clubId)).sort((a, b) => a.date.localeCompare(b.date)); }
    async listUpcoming(today: string): Promise<ScheduleException[]> { return (await this.list()).filter((item) => item.date >= today); }
    async listHistory(today: string): Promise<ScheduleException[]> { return (await this.list()).filter((item) => item.date < today).reverse(); }
    async findById(id: string): Promise<ScheduleException | undefined> { const item = await this.repository.findById(id); return item?.clubId === this.clubId ? item : undefined; }
    async findForOccurrence(scheduleEntryId: string, date: string): Promise<ScheduleException | undefined> {
        const item = await this.repository.findForOccurrence(scheduleEntryId, date); return item?.clubId === this.clubId ? item : undefined;
    }
    async save(input: SaveScheduleExceptionInput): Promise<ScheduleException> {
        return this.serialize(async () => {
            this.validate(input);
            const previous = input.id ? await this.findById(input.id) : input.scheduleEntryId ? await this.findForOccurrence(input.scheduleEntryId, input.date) : undefined;
            const now = nowIso();
            const base = input.id ? {} : previous;
            const saved = await this.repository.save({ ...base, ...input, id: previous?.id ?? input.id ?? createId('exception'), clubId: this.clubId,
                createdAt: previous?.createdAt ?? now, updatedAt: now });
            await this.onChanged?.(saved, previous);
            return saved;
        });
    }
    async delete(id: string): Promise<ScheduleException | undefined> {
        return this.serialize(async () => { const previous = await this.findById(id); if (!previous) return undefined; await this.repository.delete(id); await this.onChanged?.(undefined, previous); return previous; });
    }
    async countFutureForEntries(entryIds: readonly string[], today: string): Promise<number> {
        const ids = new Set(entryIds); return (await this.listUpcoming(today)).filter((item) => item.type !== 'extra' && item.scheduleEntryId && ids.has(item.scheduleEntryId)).length;
    }
    async deleteForEntries(entryIds: readonly string[]): Promise<number> { const ids = new Set(entryIds); const matches = (await this.list()).filter((item) => item.type !== 'extra' && item.scheduleEntryId && ids.has(item.scheduleEntryId)); for (const item of matches) await this.repository.delete(item.id); return matches.length; }
    setOnChanged(callback: (exception: ScheduleException | undefined, previous?: ScheduleException) => Promise<void>): void { this.onChanged = callback; }
    private validate(input: SaveScheduleExceptionInput): void {
        if (input.clubId !== this.clubId) throw new Error('Виняток належить іншому клубу.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) throw new Error('Дата має бути у форматі YYYY-MM-DD.');
        if (input.type !== 'extra' && !input.scheduleEntryId) throw new Error('Не вибрано запис розкладу.');
        for (const value of [input.startTime, input.endTime, input.publishTime]) if (value !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Час має бути у форматі HH:mm.');
        if (input.startTime && input.endTime && input.startTime >= input.endTime) throw new Error('Час завершення має бути пізніше за початок.');
        if (input.placesLimit !== undefined && (!Number.isInteger(input.placesLimit) || input.placesLimit < 1)) throw new Error('Кількість місць має бути більшою за нуль.');
        if (input.minPlayers !== undefined && (!Number.isInteger(input.minPlayers) || input.minPlayers < 0)) throw new Error('Мінімум не може бути відʼємним.');
        if (input.placesLimit !== undefined && input.minPlayers !== undefined && input.minPlayers > input.placesLimit) throw new Error('Не можна встановити мінімум більший за кількість місць.');
        if (input.type === 'extra' && (!input.title?.trim() || !input.startTime || !input.endTime || !input.placesLimit || input.minPlayers === undefined || !input.publishTime || !input.chatIds?.length)) throw new Error('Заповніть усі дані додаткового тренування.');
    }
    private async serialize<T>(operation: () => Promise<T>): Promise<T> { const previous = this.mutationQueue; let release!: () => void; this.mutationQueue = new Promise((resolve) => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
}
