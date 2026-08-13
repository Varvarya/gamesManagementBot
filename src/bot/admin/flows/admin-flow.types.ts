import {
    UpdateTrainingTemplateSlotInput,
} from '../../../domain/templates/template.types';


export const ADMIN_FLOW_STATES = [
    'idle',
    'waiting_template_quick_input',
    'waiting_template_edit_input',
    'waiting_template_chat_selection',
    'waiting_chat_data',
    'waiting_player_name',
    'waiting_new_player_name',
    'waiting_player_search',
    'waiting_player_selection',
    'waiting_player_alias',
    'waiting_player_merge_target',
    'waiting_player_merge_confirmation',
    'waiting_player_training_places',
    'waiting_training_add_player',
    'waiting_training_remove_player',
    'waiting_training_reservation_places',
    'waiting_training_new_player_name',
    'waiting_training_new_player_places',
    'waiting_training_new_player_confirmation',
    'waiting_training_archive_search',
    'waiting_training_search',
    'waiting_training_edit_value',
    'waiting_training_create',
    'waiting_setting_value',
    'waiting_admin_id',
    'waiting_admin_add_confirmation',
    'waiting_admin_remove_selection',
    'waiting_admin_remove_confirmation',
    'waiting_owner_transfer_selection',
    'waiting_owner_transfer_confirmation',
    'waiting_config_import',
    'waiting_player_import_file',
    'player_import_preview',
    'player_import_conflicts',
    'player_import_ready',
    'waiting_telegram_qr_2fa_password',
    'waiting_telegram_import_source',
    'waiting_exception_date',
    'waiting_exception_value',
    'waiting_exception_extra',
] as const;

export type AdminFlowState = typeof ADMIN_FLOW_STATES[number];

export type PendingTemplate = {
    title: string;
    location?: string;

    placesLimit: number;
    minPlayers: number;

    publishDaysBefore: number;
    publishTime: string;
    chatId?: number;

    slots: UpdateTrainingTemplateSlotInput[];
};

export type AdminFlowData = {
    templateId?: string;
    playerId?: string;
    trainingId?: string;
    reservedPlaces?: number;
    reservationAction?: 'add' | 'remove';
    sourcePlayerId?: string;
    searchQuery?: string;
    playerResultIds?: string[];
    playerSelectionAction?: 'open' | 'confirm' | 'edit' | 'merge_source' | 'merge_target';
    playerSearchScope?: 'all' | 'unconfirmed';
    includeInactive?: boolean;
    playerBrowsePage?: number;
    playerBrowseScope?: 'active' | 'inactive';
    returnCallback?: string;
    duplicatePlayerIds?: string[];
    allowDuplicatePlayerCreation?: boolean;
    targetPlayerId?: string;
    pendingPlayerName?: string;
    newTrainingPlayerPlaces?: number;
    pendingChatName?: string;
    pendingChatId?: number;
    pendingChatAvailable?: boolean;
    pendingChatValidationWarning?: string;
    settingField?: string;
    pendingAdminTelegramId?: number;
    adminCandidateIds?: number[];
    currentOwnerTelegramUserId?: number;
    templateChatId?: number;

    pendingTemplate?: PendingTemplate;
    pendingImport?: unknown;
    exceptionDate?: string;
    exceptionEntryId?: string;
    exceptionId?: string;
    exceptionAction?: 'cancel' | 'time' | 'places' | 'minimum' | 'chat' | 'publication' | 'publication_now' | 'publication_manual' | 'multiple' | 'extra';
    pendingException?: unknown;
    trainingEditField?: 'time' | 'limit' | 'minimum' | 'chat' | 'location' | 'title';
    pendingTrainingChanges?: Record<string, unknown>;
    pendingOneOffTraining?: Record<string, unknown>;
    pendingTrainingPublicationAt?: string;
    trainingWeekStart?: string;
};

export type AdminSession = {
    telegramUserId: number;
    state: AdminFlowState;
    data: AdminFlowData;
};
