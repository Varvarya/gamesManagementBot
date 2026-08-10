import { ClubCreationRequestRepository } from '../../storage/repositories/club-creation-request.repository';
import { ClubRepository } from '../../storage/repositories/club.repository';
import { SessionContextService } from '../session/session-context.service';
import { AdminCallbacks } from '../admin/callbacks/admin-callbacks';
import { logger } from '../../utils/logger';
import { isTelegramUserClubAdmin } from '../../domain/settings/club-admin-authorization';

export type CallbackAccess = 'public' | 'user' | 'club_admin' | 'super_admin';

export type CallbackAuthorizationInput = {
    telegramUserId: number;
    callback: string;
    activeClubId?: string;
    requiredAccess?: CallbackAccess;
};

export class CallbackAuthorizationService {
    constructor(
        private readonly clubs: ClubRepository,
        private readonly requests: ClubCreationRequestRepository,
        superAdminIds: readonly number[],
        private readonly sessions?: SessionContextService,
    ) { this.superAdminIds = [...new Set(superAdminIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]; }

    private readonly superAdminIds: readonly number[];

    requiredAccess(callback: string): CallbackAccess {
        if (PUBLIC_CALLBACKS.has(callback)) return 'public';
        if (callback.startsWith('superadmin:')) return 'super_admin';
        if (callback === 'mode:club_select' || callback.startsWith('mode:club:') || callback === 'mode:super') return 'super_admin';
        if (callback.startsWith('system:')) return 'super_admin';
        if (callback.startsWith(AdminCallbacks.ClubRequestApprovePrefix) || callback.startsWith(AdminCallbacks.ClubRequestRejectPrefix) || callback === AdminCallbacks.ClubRequestList) return 'super_admin';
        if (callback.startsWith(AdminCallbacks.ClubRequestViewPrefix) || callback.startsWith(AdminCallbacks.ClubRequestEditPrefix) || callback.startsWith(AdminCallbacks.ClubRequestCancelPrefix)) return 'user';
        if (callback === 'clubs:menu' || callback === 'clubs:list' || callback === 'club:create' || callback.startsWith('club:create:')) return 'super_admin';
        if (/^club:(?:view|delete|admins|addadmin|removeadmin|settings):/.test(callback)) return 'super_admin';
        if (callback.startsWith('onboarding:select:')) return 'user';
        if (callback.startsWith('onboarding:club:')) return 'user';
        return 'club_admin';
    }

    async canAccessCallback(input: CallbackAuthorizationInput): Promise<boolean> {
        const required = input.requiredAccess ?? this.requiredAccess(input.callback);
        return this.canAccess({ telegramUserId: input.telegramUserId, requiredAccess: required, activeClubId: input.activeClubId });
    }

    async canAccess(input: { telegramUserId: number; requiredAccess: CallbackAccess; activeClubId?: string }): Promise<boolean> {
        const userId = Number(input.telegramUserId);
        const isSuperAdmin = this.isSuperAdmin(userId);
        const session = this.sessions?.get(userId);
        const activeClubId = input.requiredAccess === 'club_admin' ? session?.activeClubId ?? input.activeClubId : input.activeClubId;
        let clubIdLoaded: string | undefined;
        let repositoryClubId: string | undefined;
        let clubAdminIds: number[] = [];
        let isClubAdmin = false;
        let allowed: boolean;
        switch (input.requiredAccess) {
            case 'public': allowed = true; break;
            case 'user': allowed = Number.isSafeInteger(userId) && userId > 0; break;
            case 'super_admin': allowed = isSuperAdmin; break;
            case 'club_admin':
                if (activeClubId) {
                    const context = await this.clubs.loadAuthorizationContext(activeClubId);
                    clubIdLoaded = context.club?.id;
                    repositoryClubId = context.repositoryClubId;
                    clubAdminIds = context.adminTelegramIds;
                    isClubAdmin = context.club !== undefined
                        && context.repositoryClubId === activeClubId
                        && isTelegramUserClubAdmin(context.admins, userId);
                }
                allowed = isSuperAdmin || isClubAdmin;
                break;
        }
        logger.info('telegram.authorization', {
            telegramUserId: userId,
            activeClubId,
            sessionClubId: session?.activeClubId,
            clubFound: clubIdLoaded !== undefined,
            clubIdLoaded,
            loadedClubId: clubIdLoaded,
            repositoryClubId,
            clubAdminIds,
            isClubAdmin,
            isSuperAdmin,
            requiredAccess: input.requiredAccess,
            allowed,
        });
        if (!allowed && input.requiredAccess === 'club_admin') logger.warn('admin.session_debug', { telegramUserId: userId, action: 'authorization_denied', mode: session?.mode, activeClubId, repositoryClubId, settingsClubId: repositoryClubId, adminEntries: clubAdminIds, isClubAdmin, flowState: undefined });
        return allowed;
    }

    isSuperAdmin(telegramUserId: number): boolean { return this.superAdminIds.includes(Number(telegramUserId)); }
    async recordMeaningfulActivity(activeClubId: string): Promise<void> { if (await this.clubs.findById(activeClubId)) await this.clubs.touchActivity(activeClubId); }
}

const PUBLIC_CALLBACKS = new Set([
    'onboarding:start', 'onboarding:join', 'onboarding:create',
    AdminCallbacks.ClubRequestCreate, AdminCallbacks.ClubRequestConfirm, AdminCallbacks.ClubRequestEdit, AdminCallbacks.ClubRequestCancel,
]);
