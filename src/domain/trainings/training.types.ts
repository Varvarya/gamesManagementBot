export type TrainingId = string;
export type ParticipantEntryId = string;

export type TrainingStatus =
    | 'draft'
    | 'open'
    | 'closed'
    | 'cancelled'
    | 'finished';

export type ParticipantStatus =
    | 'active'
    | 'waiting'
    | 'cancelled';

export type ParticipantSource =
    | 'telegram'
    | 'admin';

export type ParticipantEntry = {
    id: ParticipantEntryId;

    playerId: string;
    telegramUserId?: number;

    places: number;

    source: ParticipantSource;
    status: ParticipantStatus;

    createdAt: string;
    updatedAt: string;
};

export type Training = {
    id: TrainingId;
    clubId: string;
    templateId?: string;
    templateSlotId?: string;

    chatId: number;
    messageId?: number;

    title: string;
    location?: string;

    date: string; // YYYY-MM-DD
    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;

    status: TrainingStatus;

    participants: ParticipantEntry[];
    waitlist: ParticipantEntry[];

    createdAt: string;
    publishedAt?: string;
    updatedAt: string;
};