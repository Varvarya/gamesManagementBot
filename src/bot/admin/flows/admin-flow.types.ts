import {
    CreateTrainingTemplateSlotInput,
} from '../../../domain/templates/template.types';


export type AdminFlowState =
    | 'idle'
    | 'waiting_template_quick_input'
    | 'waiting_template_edit_input'
    | 'waiting_player_name'
    | 'waiting_new_player_name'
    | 'waiting_training_add_player'
    | 'waiting_training_remove_player'
    | 'waiting_cancel_check_hours'
    | 'waiting_config_import';

export type PendingTemplate = {
    title: string;
    location?: string;

    placesLimit: number;
    minPlayers: number;

    publishDaysBefore: number;
    publishTime: string;

    slots: CreateTrainingTemplateSlotInput[];
};

export type AdminFlowData = {
    templateId?: string;
    playerId?: string;
    trainingId?: string;

    pendingTemplate?: PendingTemplate;
    pendingImport?: unknown;
};

export type AdminSession = {
    telegramUserId: number;
    state: AdminFlowState;
    data: AdminFlowData;
};