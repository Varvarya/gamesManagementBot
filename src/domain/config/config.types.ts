import { ChatConfig } from '../chats/chat.types';
import { Player } from '../players/player.types';
import { ClubSettings } from '../settings/settings.types';
import { TrainingTemplate } from '../templates/template.types';

export type ImportedClubConfig = {
    schemaVersion?: 1;
    exportedAt?: string;
    data?: {
        settings: ClubSettings;
        chats: ChatConfig[];
        players: Player[];
        templates: TrainingTemplate[];
    };

    // Legacy import format retained for compatibility.
    club?: {
        title?: string;
        timezone?: string;
        chatId?: number;
        cancelCheckHoursBefore?: number;
        defaultPlacesLimit?: number;
        defaultMinPlayers?: number;
        defaultPublishDaysBefore?: number;
        defaultPublishTime?: string;
        cleanChatMode?: boolean;
    };

    templates?: ImportedTemplateConfig[];
};

export type ImportSectionPreview = { current: number; incoming: number; added: number; updated: number; removed: number };
export type ImportPreview = {
    mode: 'snapshot' | 'legacy';
    settingsChanged: boolean;
    chats: ImportSectionPreview;
    players: ImportSectionPreview;
    templates: ImportSectionPreview;
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
