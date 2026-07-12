export type ImportedClubConfig = {
    club?: {
        title?: string;
        timezone?: string;
        chatId?: number;
        cancelCheckHoursBefore?: number;
    };

    templates?: ImportedTemplateConfig[];
};

export type ImportedTemplateConfig = {
    title?: string;
    location?: string;

    dayOfWeek: number;

    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;

    publishDayOfWeek: number;
    publishTime: string;

    enabled?: boolean;
};