import { Context } from 'telegraf';
import { AdminFlowService } from '../admin/flows/admin-flow.service';
import { AdminUi } from '../admin/ui/admin-ui';
import { NavigationEntry, SessionContextService, SessionMode } from '../session/session-context.service';
import { AdminKeyboard } from '../admin/ui/admin-ui';

export const NavigationScreens = {
    CLUB_ADMIN_ROOT: 'm',
    SUPER_ADMIN_ROOT: 'superadmin:menu',
    MODE_SELECTOR: 'mode:selector',
} as const;

export type RootScreen = typeof NavigationScreens[keyof typeof NavigationScreens];

export function getRootScreen(session: { mode: SessionMode; activeClubId?: string } | undefined): RootScreen {
    if (session?.mode === SessionMode.CLUB_ADMIN && session.activeClubId) return NavigationScreens.CLUB_ADMIN_ROOT;
    if (session?.mode === SessionMode.SUPER_ADMIN) return NavigationScreens.SUPER_ADMIN_ROOT;
    return NavigationScreens.MODE_SELECTOR;
}

export class AdminNavigationService {
    constructor(private readonly sessions: SessionContextService, private readonly ui: AdminUi, private readonly flows: AdminFlowService) {}

    navigate(telegramUserId: number, screen: string, params?: Record<string, string>): void { this.sessions.navigate(telegramUserId, { screen, params }); }
    replace(telegramUserId: number, screen: string, params?: Record<string, string>): void { this.sessions.replace(telegramUserId, { screen, params }); }
    back(telegramUserId: number): NavigationEntry | undefined { return this.sessions.back(telegramUserId); }
    backScreen(telegramUserId: number): string {
        return this.back(telegramUserId)?.screen ?? getRootScreen(this.sessions.get(telegramUserId));
    }
    resetToRoot(telegramUserId: number): void { this.sessions.resetNavigation(telegramUserId); }

    async switchMode(ctx: Context, mode: SessionMode.SUPER_ADMIN | SessionMode.CLUB_ADMIN, club?: { id: string; name: string }): Promise<void> {
        if (!ctx.from) return;
        this.flows.finish(ctx.from.id);
        await this.ui.hardReset(ctx);
        if (mode === SessionMode.SUPER_ADMIN) this.sessions.enterSuperAdmin(ctx.from.id);
        else if (club) this.sessions.enterClubAdmin(ctx.from.id, club);
    }
    async freshRoot(ctx: Context, text: string, keyboard?: AdminKeyboard): Promise<void> { await this.ui.showFreshRoot(ctx, text, keyboard); }
    async show(ctx: Context, text: string, keyboard?: AdminKeyboard): Promise<void> { await this.ui.show(ctx, text, keyboard); }
    async showFresh(ctx: Context, text: string, keyboard?: AdminKeyboard): Promise<void> { await this.ui.showFresh(ctx, text, keyboard); }
}
