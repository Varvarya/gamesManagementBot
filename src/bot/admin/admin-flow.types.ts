export type AdminFlowState =
    | 'idle'
    | 'waiting_template_quick_input'
    | 'waiting_template_edit_input'
    | 'waiting_config_import'
    | 'waiting_player_name'
    | 'waiting_training_add_player'
    | 'waiting_training_remove_player'
    | 'waiting_new_player_name';


export type PendingTemplate = {
    title: string;

    dayOfWeek: number;

    startTime: string;
    endTime: string;

    placesLimit: number;
    minPlayers: number;

    publishDayOfWeek: number;
    publishTime: string;
};

export type AdminFlowData = {
    templateId?: string;
    playerId?: string;
    trainingId?: string;

    editingField?: keyof PendingTemplate;

    pendingTemplate?: PendingTemplate;
    pendingImport?: unknown;
};

export type AdminSession = {
    telegramUserId: number;
    state: AdminFlowState;
    data: AdminFlowData;
};