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

        return this.createIdleSession(
            telegramUserId,
        );
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

    start(
        telegramUserId: number,
        state: AdminFlowState,
        data: Partial<AdminFlowData> = {},
    ): AdminSession {
        const session: AdminSession = {
            telegramUserId,
            state,
            data: {
                ...data,
            },
        };

        this.sessions.set(
            telegramUserId,
            session,
        );

        return session;
    }

    transition(
        telegramUserId: number,
        state: AdminFlowState,
        data: Partial<AdminFlowData> = {},
    ): AdminSession {
        const session =
            this.getSession(telegramUserId);

        const updated: AdminSession = {
            telegramUserId,
            state,
            data: {
                ...session.data,
                ...data,
            },
        };

        this.sessions.set(
            telegramUserId,
            updated,
        );

        return updated;
    }

    setData(
        telegramUserId: number,
        data: Partial<AdminFlowData>,
    ): AdminSession {
        const session =
            this.getSession(telegramUserId);

        const updated: AdminSession = {
            ...session,
            data: {
                ...session.data,
                ...data,
            },
        };

        this.sessions.set(
            telegramUserId,
            updated,
        );

        return updated;
    }

    clearData(
        telegramUserId: number,
    ): AdminSession {
        const session =
            this.getSession(telegramUserId);

        const updated: AdminSession = {
            ...session,
            data: {},
        };

        this.sessions.set(
            telegramUserId,
            updated,
        );

        return updated;
    }

    finish(
        telegramUserId: number,
    ): AdminSession {
        return this.reset(telegramUserId);
    }

    reset(
        telegramUserId: number,
    ): AdminSession {
        return this.createIdleSession(
            telegramUserId,
        );
    }

    private createIdleSession(
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