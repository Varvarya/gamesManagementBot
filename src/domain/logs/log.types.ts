export type ActionLogType =
    | 'training_created'
    | 'training_published'
    | 'player_joined'
    | 'player_left'
    | 'player_updated'
    | 'training_cancelled'
    | 'training_closed'
    | 'template_updated'
    | 'ignored_action';

export type ActionLog = {
    id: string;
    clubId: string;

    type: ActionLogType;

    actorTelegramUserId?: number;
    trainingId?: string;
    playerId?: string;

    payload?: Record<string, unknown>;

    createdAt: string;
};