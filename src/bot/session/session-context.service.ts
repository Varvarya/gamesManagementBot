export enum SessionMode {
    SUPER_ADMIN = 'SUPER_ADMIN',
    CLUB_ADMIN = 'CLUB_ADMIN',
    USER = 'USER',
}

export type SessionContext = {
    mode: SessionMode;
    activeClubId?: string;
    activeClubName?: string;
    lastClubId?: string;
    navigationStack: NavigationEntry[];
    currentUiMessageId?: number;
    trackedUiMessageIds: number[];
    temporaryUserMessageIds: number[];
    setupIntroSeen?: boolean;
};

export type NavigationEntry = { screen: string; params?: Record<string, string> };

export class SessionContextService {
    private readonly sessions = new Map<number, SessionContext>();

    get(telegramUserId: number): SessionContext | undefined {
        const session = this.sessions.get(telegramUserId);
        return session ? clone(session) : undefined;
    }

    enterSuperAdmin(telegramUserId: number): SessionContext {
        const previous = this.sessions.get(telegramUserId);
        const session = fresh(SessionMode.SUPER_ADMIN);
        session.lastClubId = previous?.activeClubId ?? previous?.lastClubId;
        this.sessions.set(telegramUserId, session);
        return clone(session);
    }

    enterClubAdmin(telegramUserId: number, club: { id: string; name: string }): SessionContext {
        const session = fresh(SessionMode.CLUB_ADMIN, club);
        session.lastClubId = club.id;
        this.sessions.set(telegramUserId, session);
        return clone(session);
    }

    enterClubUser(telegramUserId: number, club: { id: string; name: string }): SessionContext {
        const session = fresh(SessionMode.USER, club);
        this.sessions.set(telegramUserId, session);
        return clone(session);
    }

    navigate(telegramUserId: number, entry: NavigationEntry): void { const session = this.sessions.get(telegramUserId); if (session) session.navigationStack.push({ ...entry, params: entry.params ? { ...entry.params } : undefined }); }
    replace(telegramUserId: number, entry: NavigationEntry): void { const session = this.sessions.get(telegramUserId); if (!session) return; session.navigationStack.pop(); this.navigate(telegramUserId, entry); }
    back(telegramUserId: number): NavigationEntry | undefined { const session = this.sessions.get(telegramUserId); if (!session) return undefined; session.navigationStack.pop(); const previous = session.navigationStack.at(-1); return previous ? { ...previous, params: previous.params ? { ...previous.params } : undefined } : undefined; }
    resetNavigation(telegramUserId: number): void { const session = this.sessions.get(telegramUserId); if (session) session.navigationStack = []; }
    clearFlowState(telegramUserId: number): void { this.resetNavigation(telegramUserId); }
    resetModeContext(telegramUserId: number): void { this.sessions.delete(telegramUserId); }
    trackUiMessage(telegramUserId: number, messageId: number, current = false): void { const session = this.sessions.get(telegramUserId); if (!session) return; if (!session.trackedUiMessageIds.includes(messageId)) session.trackedUiMessageIds.push(messageId); if (current) session.currentUiMessageId = messageId; }
    trackTemporaryUserMessage(telegramUserId: number, messageId: number): void { const session = this.sessions.get(telegramUserId); if (session && !session.temporaryUserMessageIds.includes(messageId)) session.temporaryUserMessageIds.push(messageId); }
    clearTrackedMessages(telegramUserId: number): void { const session = this.sessions.get(telegramUserId); if (!session) return; session.trackedUiMessageIds = []; session.temporaryUserMessageIds = []; session.currentUiMessageId = undefined; }
    markSetupIntroSeen(telegramUserId: number): void { const session = this.sessions.get(telegramUserId); if (session) session.setupIntroSeen = true; }

    clear(telegramUserId: number): void { this.sessions.delete(telegramUserId); }
}

function fresh(mode: SessionMode, club?: { id: string; name: string }): SessionContext { return { mode, activeClubId: club?.id, activeClubName: club?.name, navigationStack: [], trackedUiMessageIds: [], temporaryUserMessageIds: [] }; }
function clone(session: SessionContext): SessionContext { return { ...session, navigationStack: session.navigationStack.map((entry) => ({ ...entry, params: entry.params ? { ...entry.params } : undefined })), trackedUiMessageIds: [...session.trackedUiMessageIds], temporaryUserMessageIds: [...session.temporaryUserMessageIds] }; }
