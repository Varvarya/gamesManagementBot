import { BaseJsonRepository } from './baseJsonRepository';
import { ScheduleException } from '../../domain/schedule-exceptions/schedule-exception.types';

export class ScheduleExceptionsRepository extends BaseJsonRepository<ScheduleException> {
    async listByClubId(clubId: string): Promise<ScheduleException[]> { return (await this.list()).filter((item) => item.clubId === clubId); }
    async findForOccurrence(scheduleEntryId: string, date: string): Promise<ScheduleException | undefined> {
        return (await this.list()).find((item) => item.scheduleEntryId === scheduleEntryId && item.date === date && item.type !== 'extra');
    }
}
