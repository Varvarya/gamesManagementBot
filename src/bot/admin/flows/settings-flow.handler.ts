import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { EditableSetting } from '../../../domain/settings/settings.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { AdminSettingsHandler } from '../handlers/admin-settings.handler';
import { AdminFlowState } from './admin-flow.types';

export class SettingsFlowHandler {
    readonly textStates: readonly AdminFlowState[] = ['waiting_setting_value', 'waiting_admin_id', 'waiting_admin_remove_selection', 'waiting_owner_transfer_selection'];
    readonly messageStates: readonly AdminFlowState[] = ['waiting_admin_id'];
    constructor(private readonly services: ServicesContext, private readonly settingsHandler: AdminSettingsHandler) {}
    canHandleText(adminId: number): boolean { return this.textStates.includes(this.services.adminFlow.getState(adminId)); }
    canHandleMessage(adminId: number): boolean { return this.services.adminFlow.getState(adminId) === 'waiting_admin_id'; }

    async handleMessage(ctx: Context): Promise<boolean> {
        const adminId = ctx.from?.id;
        if (!adminId || !this.canHandleMessage(adminId) || !ctx.message) return false;
        const message = ctx.message as typeof ctx.message & { contact?: { user_id?: number }; forward_origin?: { sender_user?: { id: number } } };
        const id = message.contact?.user_id ?? message.forward_origin?.sender_user?.id;
        if (!id) return 'text' in message ? false : this.fail(ctx, 'Telegram не надав ID. Введіть числовий Telegram ID.');
        await this.preview(ctx, adminId, String(id));
        return true;
    }

    async handleText(ctx: Context, text: string): Promise<void> {
        const adminId = ctx.from?.id;
        if (!adminId) return;
        const state = this.services.adminFlow.getState(adminId);
        try {
            if (state === 'waiting_admin_id') { await this.preview(ctx, adminId, text); return; }
            if (state === 'waiting_admin_remove_selection' || state === 'waiting_owner_transfer_selection') {
                await this.settingsHandler.previewSelection(ctx, adminId, Number(text.trim()), state === 'waiting_owner_transfer_selection');
                return;
            }
            const field = this.services.adminFlow.getData(adminId).settingField as EditableSetting | undefined;
            if (!field) return;
            await this.settingsHandler.update(field, text);
            this.services.adminFlow.reset(adminId);
            await this.settingsHandler.show(ctx);
        } catch (error) { await this.fail(ctx, error instanceof Error ? error.message : 'Некоректне значення.'); }
    }

    private async preview(ctx: Context, adminId: number, query: string): Promise<void> {
        const telegramUserId = await this.settingsHandler.resolveAdminIdentity(query);
        await this.settingsHandler.previewAdmin(ctx, adminId, telegramUserId);
    }
    private async fail(ctx: Context, message: string): Promise<true> {
        await this.services.adminUi.replaceWithError(ctx, message, createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
        return true;
    }
}
