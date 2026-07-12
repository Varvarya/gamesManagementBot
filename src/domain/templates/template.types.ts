export type TrainingTemplateId = string;

export type TrainingTemplate = {
    id: TrainingTemplateId;
    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    dayOfWeek: number; // 1-7
    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;

    publishDayOfWeek: number; // 1-7
    publishTime: string; // HH:mm

    enabled: boolean;

    createdAt: string;
    updatedAt: string;
};