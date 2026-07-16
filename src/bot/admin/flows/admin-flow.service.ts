import {
    AdminFlowData,
    AdminFlowState,
    AdminSession,
} from './admin-flow.types';

export class AdminFlowService {
    private readonly sessions =
        new Map<number, AdminSession>();

    getSession(
        telegramUserId: number,
    ): AdminSession {
        const existing =
            this.sessions.get(telegramUserId);

        if (existing) {
            return existing;
        }

        return this.reset(telegramUserId);
    }

    getState(
        telegramUserId: number,
    ): AdminFlowState {
        return this.getSession(
            telegramUserId,
        ).state;
    }

    getData(
        telegramUserId: number,
    ): AdminFlowData {
        return {
            ...this.getSession(
                telegramUserId,
            ).data,
        };
    }

    transition(
        telegramUserId: number,
        state: AdminFlowState,
        data?: Partial<AdminFlowData>,
    ): AdminSession {
        const session =
            this.getSession(telegramUserId);

        session.state = state;

        if (data) {
            session.data = {
                ...session.data,
                ...data,
            };
        }

        return session;
    }

    setData(
        telegramUserId: number,
        data: Partial<AdminFlowData>,
    ): AdminSession {
        const session =
            this.getSession(telegramUserId);

        session.data = {
            ...session.data,
            ...data,
        };

        return session;
    }

    reset(
        telegramUserId: number,
    ): AdminSession {
        const session: AdminSession = {
            telegramUserId,
            state: 'idle',
            data: {},
        };

        this.sessions.set(
            telegramUserId,
            session,
        );

        return session;
    }
}