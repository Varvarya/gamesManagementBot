import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';
import { EditableSetting } from '../../../domain/settings/settings.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { createAdminConfirmationKeyboard, createAdminsKeyboard, createSettingsKeyboard } from '../keyboards/settings.keyboard';
import { BackupService } from '../../../storage/backup.service';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { canManageClubAdmins, isClubOwner } from '../../../domain/settings/club-admin-authorization';
import { ClubSettings } from '../../../domain/settings/settings.types';
import { logger } from '../../../utils/logger';

export class AdminSettingsHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly cancellationScheduler: TrainingCancellationScheduler,
        private readonly backups: BackupService,
        private readonly templateScheduler?: TemplateSchedulerService,
        private readonly superAdminIds: readonly number[] = [],
    ) { void this.backups; }

    canHandle(callback: string): boolean {
        return [AdminCallbacks.Settings, AdminCallbacks.SettingsToggleCleanChat, AdminCallbacks.SettingsAdmins,
            AdminCallbacks.SettingsAddAdmin, AdminCallbacks.SettingsAddAdminConfirm, AdminCallbacks.SettingsRemoveAdmin,
            AdminCallbacks.SettingsRemoveAdminConfirm, AdminCallbacks.SettingsTransferOwner,
            AdminCallbacks.SettingsTransferOwnerConfirm, AdminCallbacks.SettingsStatus].includes(callback as never)
            || callback.startsWith(AdminCallbacks.SettingsEditPrefix)
            || callback.startsWith(AdminCallbacks.SettingsRemoveAdminPrefix);
    }

    async handle(ctx: Context, callback: string): Promise<void> {
        const actorId = ctx.from?.id;
        if (!actorId) return;
        if (callback === AdminCallbacks.Settings) { this.services.adminFlow.finish(actorId); await this.show(ctx); return; }
        if (callback === AdminCallbacks.SettingsAdmins) { this.services.adminFlow.finish(actorId); await this.showAdmins(ctx); return; }
        if (callback.startsWith(AdminCallbacks.SettingsEditPrefix)) {
            const settingField = callback.slice(AdminCallbacks.SettingsEditPrefix.length) as EditableSetting;
            if (settingField !== 'title' && settingField !== 'timezone') return this.show(ctx);
            this.services.adminFlow.transition(actorId, 'waiting_setting_value', { settingField });
            await this.services.adminUi.show(ctx, `✏️ ${this.fieldTitle(settingField)}\n\nНадішліть нове значення.`, createFlowCancelKeyboard(AdminCallbacks.Settings));
            return;
        }
        if (callback === AdminCallbacks.SettingsToggleCleanChat) { await this.services.settings.toggleCleanChat(); await this.show(ctx); return; }
        if (callback === AdminCallbacks.SettingsStatus) { await this.show(ctx); return; }
        if (!await this.ensureManager(ctx, actorId)) return;

        if (callback === AdminCallbacks.SettingsAddAdmin) {
            this.services.adminFlow.transition(actorId, 'waiting_admin_id');
            await this.services.adminUi.show(ctx, 'Введіть Telegram ID, @username або імʼя гравця.', createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
            return;
        }
        if (callback === AdminCallbacks.SettingsAddAdminConfirm) { await this.commitAdd(ctx, actorId); return; }
        if (callback === AdminCallbacks.SettingsRemoveAdmin) { await this.startRemove(ctx, actorId); return; }
        if (callback === AdminCallbacks.SettingsRemoveAdminConfirm) { await this.commitRemove(ctx, actorId); return; }
        if (callback === AdminCallbacks.SettingsTransferOwner) { await this.startTransfer(ctx, actorId); return; }
        if (callback === AdminCallbacks.SettingsTransferOwnerConfirm) { await this.commitTransfer(ctx, actorId); return; }
        // Legacy callbacks are deliberately non-mutating; old cards are refreshed instead.
        if (callback.startsWith(AdminCallbacks.SettingsRemoveAdminPrefix)) await this.showAdmins(ctx);
    }

    async show(ctx: Context): Promise<void> {
        const settings = await this.services.settings.get();
        await this.services.adminUi.show(ctx, '⚙️ Налаштування', createSettingsKeyboard(settings.cleanChatMode));
    }

    async update(field: EditableSetting, value: string): Promise<void> {
        const previous = await this.services.settings.get();
        await this.services.settings.update(field, value);
        if (field !== 'timezone') return;
        try {
            if (this.templateScheduler) await this.templateScheduler.restore(await this.services.repositories.templates.list());
            await this.cancellationScheduler.restore();
        } catch (error) {
            await this.services.repositories.settings.save(previous);
            if (this.templateScheduler) await this.templateScheduler.restore(await this.services.repositories.templates.list());
            await this.cancellationScheduler.restore();
            throw new Error('Не вдалося оновити розклад. Попередній часовий пояс відновлено.', { cause: error });
        }
    }

    async showAdmins(ctx: Context): Promise<void> {
        const actorId = ctx.from?.id;
        if (!actorId) return;
        const settings = await this.services.settings.get();
        const players = await this.services.repositories.players.list();
        const lines = settings.admins.map((admin, index) => {
            const player = players.find((item) => Number(item.telegramUserId) === Number(admin.telegramUserId));
            return `${index + 1}. ${player?.displayName ?? admin.telegramUserId} — ${admin.role}`;
        });
        const mayManage = canManageClubAdmins(settings.admins, actorId, this.isSuperAdmin(actorId));
        const mayTransfer = mayManage && settings.admins.some((admin) => admin.role === 'admin');
        await this.services.adminUi.show(ctx, ['👥 Адміністратори', '', ...lines].join('\n'), createAdminsKeyboard(mayManage, mayTransfer));
    }

    async previewAdmin(ctx: Context, actorId: number, telegramUserId: number): Promise<void> {
        const settings = await this.services.settings.get();
        if (!canManageClubAdmins(settings.admins, actorId, this.isSuperAdmin(actorId))) throw new Error('Лише owner може керувати адміністраторами.');
        if (settings.admins.some((admin) => Number(admin.telegramUserId) === telegramUserId)) throw new Error('Цей користувач уже є адміністратором клубу.');
        const player = await this.services.players.findByTelegramId(telegramUserId);
        this.services.adminFlow.transition(actorId, 'waiting_admin_add_confirmation', { pendingAdminTelegramId: telegramUserId });
        await this.services.adminUi.show(ctx, ['👤 Новий адміністратор', '', `Telegram ID: ${telegramUserId}`,
            player ? `Імʼя: ${player.displayName}` : undefined, player?.username ? `Username: @${player.username.replace(/^@/, '')}` : undefined,
            '', `Додати до «${settings.title}»?`].filter(Boolean).join('\n'), createAdminConfirmationKeyboard(AdminCallbacks.SettingsAddAdminConfirm));
    }

    async resolveAdminIdentity(query: string): Promise<number> {
        const value = query.trim();
        const numeric = Number(value);
        if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
        const key = value.replace(/^@/, '').trim().toLocaleLowerCase('uk');
        const players = await this.services.repositories.players.list();
        const matches = players.filter((player) => [player.username?.replace(/^@/, ''), player.displayName, player.telegramName, ...player.aliases]
            .some((candidate) => candidate?.trim().toLocaleLowerCase('uk') === key));
        if (matches.length > 1) throw new Error('Знайдено кілька користувачів. Введіть Telegram ID.');
        if (!matches.length) throw new Error('Користувача не знайдено. Введіть Telegram ID.');
        if (!matches[0].telegramUserId) throw new Error('Для цього гравця не привʼязаний Telegram-акаунт. Додайте адміністратора за Telegram ID.');
        return matches[0].telegramUserId;
    }

    private async startRemove(ctx: Context, actorId: number): Promise<void> {
        const settings = await this.services.settings.get();
        const candidates = settings.admins.filter((admin) => !(admin.role === 'owner' && settings.admins.filter((item) => item.role === 'owner').length === 1));
        if (!candidates.length) throw new Error('Немає адміністратора, якого можна видалити.');
        this.services.adminFlow.transition(actorId, 'waiting_admin_remove_selection', { adminCandidateIds: candidates.map((item) => item.telegramUserId) });
        await this.services.adminUi.show(ctx, ['➖ Видалити адміністратора', '', ...candidates.map((item, i) => `${i + 1}. ${item.telegramUserId} — ${item.role}`), '', 'Надішліть номер зі списку.'].join('\n'), createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
    }

    private async startTransfer(ctx: Context, actorId: number): Promise<void> {
        const settings = await this.services.settings.get();
        const candidates = settings.admins.filter((admin) => admin.role === 'admin');
        const owners = settings.admins.filter((admin) => admin.role === 'owner');
        const currentOwner = isClubOwner(settings.admins, actorId) ? actorId : owners.length === 1 ? owners[0].telegramUserId : undefined;
        if (!currentOwner) throw new Error('Оберіть конкретного owner перед передачею прав.');
        if (!candidates.length) throw new Error('Спочатку додайте адміністратора.');
        this.services.adminFlow.transition(actorId, 'waiting_owner_transfer_selection', { adminCandidateIds: candidates.map((item) => item.telegramUserId), currentOwnerTelegramUserId: currentOwner });
        await this.services.adminUi.show(ctx, ['👑 Передати owner', '', ...candidates.map((item, i) => `${i + 1}. ${item.telegramUserId}`), '', 'Надішліть номер зі списку.'].join('\n'), createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
    }

    async previewSelection(ctx: Context, actorId: number, selection: number, transfer: boolean): Promise<void> {
        const data = this.services.adminFlow.getData(actorId);
        const targetId = data.adminCandidateIds?.[selection - 1];
        if (!targetId) throw new Error('Оберіть номер зі списку.');
        this.services.adminFlow.transition(actorId, transfer ? 'waiting_owner_transfer_confirmation' : 'waiting_admin_remove_confirmation', { pendingAdminTelegramId: targetId });
        const settings = await this.services.settings.get();
        await this.services.adminUi.show(ctx, transfer
            ? `👑 Передати права owner?\n\nЗ: ${data.currentOwnerTelegramUserId}\nКому: ${targetId}`
            : `Видалити ${targetId} з адміністраторів «${settings.title}»?`,
        createAdminConfirmationKeyboard(transfer ? AdminCallbacks.SettingsTransferOwnerConfirm : AdminCallbacks.SettingsRemoveAdminConfirm));
    }

    private async commitAdd(ctx: Context, actorId: number): Promise<void> {
        const targetId = this.services.adminFlow.getData(actorId).pendingAdminTelegramId;
        if (!targetId) return this.showAdmins(ctx);
        const settings = await this.revalidateManager(actorId);
        await this.services.settings.addAdmin(targetId);
        this.services.adminFlow.finish(actorId);
        try { await ctx.telegram.sendMessage(targetId, `Вас додано адміністратором клубу «${settings.title}».`); }
        catch (error) { logger.warn('club.admin_notification_failed', { clubId: settings.clubId, telegramUserId: targetId, reason: error instanceof Error ? error.message : String(error) }); }
        await this.showAdmins(ctx);
    }

    private async commitRemove(ctx: Context, actorId: number): Promise<void> {
        const targetId = this.services.adminFlow.getData(actorId).pendingAdminTelegramId;
        if (!targetId) return this.showAdmins(ctx);
        await this.revalidateManager(actorId);
        await this.services.settings.removeAdmin(targetId);
        this.services.adminFlow.finish(actorId);
        await this.showAdmins(ctx);
    }

    private async commitTransfer(ctx: Context, actorId: number): Promise<void> {
        const data = this.services.adminFlow.getData(actorId);
        if (!data.pendingAdminTelegramId || !data.currentOwnerTelegramUserId) return this.showAdmins(ctx);
        await this.revalidateManager(actorId);
        await this.services.settings.transferOwnership(data.currentOwnerTelegramUserId, data.pendingAdminTelegramId);
        this.services.adminFlow.finish(actorId);
        await this.showAdmins(ctx);
    }

    private async ensureManager(ctx: Context, actorId: number): Promise<boolean> {
        try { await this.revalidateManager(actorId); return true; }
        catch (error) { await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Недостатньо прав.', createAdminsKeyboard(false, false)); return false; }
    }

    private async revalidateManager(actorId: number): Promise<ClubSettings> {
        const settings = await this.services.settings.get();
        if (!canManageClubAdmins(settings.admins, actorId, this.isSuperAdmin(actorId))) throw new Error('Лише owner може керувати адміністраторами.');
        return settings;
    }
    private isSuperAdmin(id: number): boolean { return this.superAdminIds.map(Number).includes(Number(id)); }
    private fieldTitle(field: EditableSetting): string { return field === 'title' ? 'Назва клубу' : 'Часовий пояс'; }
}
