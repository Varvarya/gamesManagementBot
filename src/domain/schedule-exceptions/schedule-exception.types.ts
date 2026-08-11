export type ScheduleExceptionType = 'cancel' | 'override' | 'extra';

export type ScheduleException = {
    id: string;
    clubId: string;
    /** Stable recurring schedule time-entry id. Undefined only for extra training. */
    scheduleEntryId?: string;
    date: string;
    type: ScheduleExceptionType;
    title?: string;
    startTime?: string;
    endTime?: string;
    placesLimit?: number;
    minPlayers?: number;
    publishTime?: string;
    publishDaysBefore?: number;
    publicationEnabled?: boolean;
    chatIds?: number[];
    createdByTelegramUserId?: number;
    createdAt: string;
    updatedAt: string;
};

export type SaveScheduleExceptionInput = Omit<ScheduleException, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export type EffectiveOccurrence = {
    exceptionId?: string;
    clubId: string;
    scheduleId?: string;
    scheduleEntryId?: string;
    date: string;
    type: 'recurring' | 'override' | 'extra';
    title: string;
    location?: string;
    startTime: string;
    endTime: string;
    placesLimit: number;
    minPlayers: number;
    publishDaysBefore: number;
    publishTime: string;
    publicationEnabled: boolean;
    chatId: number;
    cancelCheckHoursBefore: number;
};
