export type ClubCreationRequestStatus = 'pending' | 'approved' | 'rejected';

export type ClubCreationRequest = {
    id: string;
    shortId: string;
    clubName: string;
    slug: string;
    requesterTelegramId: number;
    requesterDisplayName: string;
    requesterUsername?: string;
    status: ClubCreationRequestStatus;
    createdAt: string;
    reviewedAt?: string;
    reviewedByTelegramId?: number;
    reviewComment?: string;
};

export type Club = {
    id: string;
    shortId: string;
    name: string;
    slug: string;
    admins: Array<{ telegramUserId: number; role: 'owner' | 'admin' }>;
    status: 'active' | 'setup_required' | 'inactive' | 'disabled' | 'broken';
    createdAt: string;
    updatedAt: string;
    approvedAt?: string;
    lastActivityAt?: string;
    disabledAt?: string;
    lastSchedulerError?: string;
    lastSuccessfulPublicationAt?: string;
    expectedSchedulerJobs?: number;
    restoredSchedulerJobs?: number;
};

export type ClubHealth = {
    club: Club;
    status: Club['status'];
    problems: string[];
    chats: number;
    enabledTemplates: number;
    templateCount?: number;
    activeTrainings: number;
    expectedSchedulerJobs: number;
    restoredSchedulerJobs: number;
    schedulerStatus: 'healthy' | 'partial' | 'failed' | 'not_configured';
    dataAvailable?: boolean;
    playerCount?: number;
    trainingCount?: number;
};
