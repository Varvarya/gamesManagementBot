import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { EditableSetting } from '../../../domain/settings/settings.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { AdminSettingsHandler } from '../handlers/admin-settings.handler';
import { AdminFlowState } from './admin-flow.types';

export class SettingsFlowHandler {
    readonly textStates: readonly AdminFlowState[] = ['waiting_setting_value', 'waiting_admin_id'];
    readonly messageStates: readonly AdminFlowState[] = ['waiting_admin_id'];
    constructor(private readonly services: ServicesContext, private readonly settingsHandler: AdminSettingsHandler) {}

    canHandleText(adminId: number): boolean {
        return ['waiting_setting_value', 'waiting_admin_id'].includes(this.services.adminFlow.getState(adminId));
    }

    canHandleMessage(adminId: number): boolean {
        return this.services.adminFlow.getState(adminId) === 'waiting_admin_id';
    }

    async handleMessage(ctx: Context): Promise<boolean> {
        const adminId = ctx.from?.id;
        if (!adminId || !this.canHandleMessage(adminId) || !ctx.message) return false;
        const message = ctx.message as typeof ctx.message & { contact?: { user_id?: number }; forward_origin?: { type?: string; sender_user?: { id: number } } };
        const forwardedId = message.contact?.user_id ?? message.forward_origin?.sender_user?.id;
        if (!forwardedId) {
            if ('text' in message) return false;
            await this.services.adminUi.replaceWithError(ctx, 'Telegram не надав user id. Попросіть користувача дозволити пересилання або введіть його числовий ID.', createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
            return true;
        }
        await this.addAdmin(ctx, adminId, forwardedId);
        return true;
    }

    async handleText(ctx: Context, text: string): Promise<void> {
        const adminId = ctx.from?.id;
        if (!adminId) return;
        const state = this.services.adminFlow.getState(adminId);
        if (state === 'waiting_admin_id') {
            await this.addAdmin(ctx, adminId, Number(text));
            return;
        }
        const field = this.services.adminFlow.getData(adminId).settingField as EditableSetting | undefined;
        if (!field) return;
        try {
            await this.settingsHandler.update(field, text);
            this.services.adminFlow.reset(adminId);
            await this.settingsHandler.show(ctx, 'Налаштування збережено.');
        } catch (error) {
            await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Некоректне значення', createFlowCancelKeyboard(AdminCallbacks.Settings));
        }
    }

    private async addAdmin(ctx: Context, adminId: number, telegramUserId: number): Promise<void> {
        try {
            await this.services.settings.addAdmin(telegramUserId);
            this.services.adminFlow.reset(adminId);
            await this.settingsHandler.showAdmins(ctx, 'Адміністратора додано.');
        } catch (error) {
            await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося додати адміністратора', createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
        }
    }
}
