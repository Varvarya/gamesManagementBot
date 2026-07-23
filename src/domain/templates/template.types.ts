export type TrainingTemplateId = string;
export type TrainingTemplateSlotId = string;

export type TrainingTemplateSlot = {
    id: TrainingTemplateSlotId;

    /**
     * 1 = Пн
     * 7 = Нд
     */
    dayOfWeek: number;

    startTime: string;
    endTime: string;

    /**
     * Якщо значення не задане,
     * використовуємо значення з TrainingTemplate.
     */
    placesLimit?: number;
    minPlayers?: number;

    /**
     * Якщо значення не задане,
     * використовуємо значення з TrainingTemplate.
     */
    publishDaysBefore?: number;
    publishTime?: string;

    enabled: boolean;
};

export type TrainingTemplate = {
    id: TrainingTemplateId;

    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    /**
     * Значення за замовчуванням для всіх слотів.
     */
    placesLimit: number;
    minPlayers: number;

    /**
     * Значення за замовчуванням для публікації.
     *
     * Наприклад:
     * publishDaysBefore = 1
     * publishTime = "12:00"
     *
     * означає: публікувати за день до тренування о 12:00.
     */
    publishDaysBefore: number;
    publishTime: string;

    slots: TrainingTemplateSlot[];

    enabled: boolean;

    createdAt: string;
    updatedAt: string;
};

export type CreateTrainingTemplateSlotInput = {
    dayOfWeek: number;

    startTime: string;
    endTime: string;

    placesLimit?: number;
    minPlayers?: number;

    publishDaysBefore?: number;
    publishTime?: string;

    enabled?: boolean;
};

export type CreateTrainingTemplateInput = {
    clubId: string;
    chatId: number;

    title: string;
    location?: string;

    placesLimit: number;
    minPlayers: number;

    publishDaysBefore: number;
    publishTime: string;

    slots: CreateTrainingTemplateSlotInput[];

    enabled?: boolean;
};

export type UpdateTrainingTemplateSlotInput = {
    id?: TrainingTemplateSlotId;

    dayOfWeek: number;

    startTime: string;
    endTime: string;

    placesLimit?: number;
    minPlayers?: number;

    publishDaysBefore?: number;
    publishTime?: string;

    enabled?: boolean;
};

export type UpdateTrainingTemplateInput = {
    title?: string;
    location?: string;

    placesLimit?: number;
    minPlayers?: number;

    publishDaysBefore?: number;
    publishTime?: string;

    slots?: UpdateTrainingTemplateSlotInput[];

    enabled?: boolean;
};