import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';
import { EditableSetting } from '../../../domain/settings/settings.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { createAdminsKeyboard, createSettingsKeyboard, createStatusKeyboard } from '../keyboards/settings.keyboard';
import { BackupService } from '../../../storage/backup.service';
import { getLastErrorLog } from '../../../utils/logger';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';

export class AdminSettingsHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly cancellationScheduler: TrainingCancellationScheduler,
        private readonly backups: BackupService,
        private readonly templateScheduler?: TemplateSchedulerService,
    ) {}

    canHandle(callback: string): boolean {
        return callback === AdminCallbacks.Settings || callback === AdminCallbacks.SettingsToggleCleanChat || callback === AdminCallbacks.SettingsAdmins || callback === AdminCallbacks.SettingsAddAdmin || callback === AdminCallbacks.SettingsStatus || callback.startsWith(AdminCallbacks.SettingsEditPrefix) || callback.startsWith(AdminCallbacks.SettingsRemoveAdminPrefix);
    }

    async handle(ctx: Context, callback: string): Promise<void> {
        const adminId = ctx.from?.id;
        if (!adminId) return;
        if (callback === AdminCallbacks.Settings) {
            this.services.adminFlow.finish(adminId);
            await this.show(ctx);
            return;
        }
        if (callback.startsWith(AdminCallbacks.SettingsEditPrefix)) {
            const settingField = callback.replace(AdminCallbacks.SettingsEditPrefix, '') as EditableSetting;
            if (settingField !== 'title' && settingField !== 'timezone') {
                await this.services.adminUi.replaceWithError(ctx, 'Це налаштування перенесено до шаблонів тренувань.', createSettingsKeyboard((await this.services.settings.get()).cleanChatMode));
                return;
            }
            this.services.adminFlow.transition(adminId, 'waiting_setting_value', { settingField });
            await this.services.adminUi.show(ctx, ['✏️ ' + this.fieldTitle(settingField), '', 'Надішліть нове значення.', `Наприклад: ${this.fieldExample(settingField)}`].join('\n'), createFlowCancelKeyboard(AdminCallbacks.Settings));
            return;
        }
        if (callback === AdminCallbacks.SettingsAddAdmin) {
            this.services.adminFlow.transition(adminId, 'waiting_admin_id');
            await this.services.adminUi.show(ctx, 'Надішліть Telegram user id нового адміністратора або перешліть його повідомлення.', createFlowCancelKeyboard(AdminCallbacks.SettingsAdmins));
            return;
        }
        if (callback.startsWith(AdminCallbacks.SettingsRemoveAdminPrefix)) {
            try { await this.services.settings.removeAdmin(Number(callback.replace(AdminCallbacks.SettingsRemoveAdminPrefix, ''))); }
            catch (error) { await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося видалити адміністратора', createAdminsKeyboard((await this.services.settings.get()).admins)); return; }
            await this.showAdmins(ctx, 'Адміністратора видалено.'); return;
        }
        if (callback === AdminCallbacks.SettingsAdmins) { await this.showAdmins(ctx); return; }
        if (callback === AdminCallbacks.SettingsStatus) { await this.showStatus(ctx); return; }
        if (callback === AdminCallbacks.SettingsToggleCleanChat) { await this.services.settings.toggleCleanChat(); await this.show(ctx, 'Налаштування очищення чату змінено.'); return; }
        await this.show(ctx);
    }

    async show(ctx: Context, successMessage?: string): Promise<void> {
        const s = await this.services.settings.get();
        const text = ['⚙️ Налаштування клубу', '', `🏸 ${s.title}`, `🌍 ${s.timezone}`, `👮 Адміністраторів: ${s.admins.length}`, `🧹 Очищення чату: ${s.cleanChatMode ? 'Увімкнено' : 'Вимкнено'}`].join('\n');
        if (successMessage) await this.services.adminUi.replaceWithSuccess(ctx, `${successMessage}\n\n${text}`, createSettingsKeyboard(s.cleanChatMode));
        else await this.services.adminUi.show(ctx, text, createSettingsKeyboard(s.cleanChatMode));
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
            try {
                if (this.templateScheduler) await this.templateScheduler.restore(await this.services.repositories.templates.list());
                await this.cancellationScheduler.restore();
            } catch (rollbackError) {
                throw new Error('Часовий пояс збережено не було, але відновити планувальник автоматично не вдалося. Перезапустіть бот.', { cause: rollbackError });
            }
            throw new Error('Не вдалося перебудувати розклад для нового часового поясу; попереднє значення відновлено.', { cause: error });
        }
    }

    async showAdmins(ctx: Context, successMessage?: string): Promise<void> {
        const s = await this.services.settings.get();
        const text = ['👮 Адміністратори', '', ...(s.admins.length ? s.admins.map((admin) => `${admin.role === 'owner' ? '👑' : '👤'} ${admin.telegramUserId} — ${admin.role}`) : ['Адміністраторів ще немає.', 'Додайте першого адміністратора за Telegram ID.'])].join('\n');
        if (successMessage) await this.services.adminUi.replaceWithSuccess(ctx, `${successMessage}\n\n${text}`, createAdminsKeyboard(s.admins));
        else await this.services.adminUi.show(ctx, text, createAdminsKeyboard(s.admins));
    }

    private async showStatus(ctx: Context): Promise<void> {
        const s = await this.services.settings.get();
        const [chats, templates, activeTrainings, allTrainings, players, backups] = await Promise.all([
            this.services.repositories.chats.getAll(),
            this.services.repositories.templates.list(),
            this.services.repositories.trainings.listActive(),
            this.services.repositories.trainings.list(),
            this.services.repositories.players.list(),
            this.backups.list(),
        ]);
        const jobs = this.services.scheduler.getScheduledTemplateIds().length + this.cancellationScheduler.getJobCount();
        const enabledChats = chats.filter((chat) => chat.enabled).length;
        const enabledTemplates = templates.filter((template) => template.enabled).length;
        const activePlayers = players.filter((player) => player.isActive).length;
        const lastPublication = allTrainings
            .filter((training) => training.publishedAt)
            .sort((left, right) => right.publishedAt!.localeCompare(left.publishedAt!))[0];
        const lastError = getLastErrorLog();
        const latestBackup = backups[0];
        await this.services.adminUi.show(ctx, [
            '📊 Статус клубу',
            '',
            `💬 Чати: ${enabledChats} увімкнено / ${chats.length} всього`,
            `📅 Розклади: ${enabledTemplates} увімкнено / ${templates.length} всього`,
            `🏃 Активні тренування: ${activeTrainings.length}`,
            `⏱ Завдання планувальника: ${jobs}`,
            `👥 Гравці: ${activePlayers} активних / ${players.length} всього`,
            `💾 Резервні копії: ${backups.length}`,
            `🟢 Бот працює: ${formatDuration(process.uptime() * 1_000)}`,
            '',
            `📣 Остання публікація: ${lastPublication ? `${lastPublication.date} о ${lastPublication.startTime} (${formatDateTime(lastPublication.publishedAt!, s.timezone)})` : 'ще не було'}`,
            `💾 Остання копія: ${latestBackup ? formatDateTime(latestBackup.createdAt, s.timezone) : 'ще не створювалася'}`,
            `⚠️ Остання помилка: ${lastError ? `${formatDateTime(lastError.timestamp, s.timezone)}${lastError.message ? ` — ${truncate(lastError.message, 80)}` : ''}` : s.latestError ?? 'немає'}`,
        ].join('\n'), createStatusKeyboard());
    }

    private fieldTitle(field: EditableSetting): string { return ({ title: 'назва клубу', timezone: 'часовий пояс' })[field]; }
    private fieldExample(field: EditableSetting): string { return ({ title: 'Бадмінтон Київ', timezone: 'Europe/Kyiv' })[field]; }
}

function formatDuration(milliseconds: number): string {
    const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
    const days = Math.floor(totalMinutes / 1_440);
    const hours = Math.floor((totalMinutes % 1_440) / 60);
    const minutes = totalMinutes % 60;
    return [days ? `${days} дн.` : '', hours ? `${hours} год.` : '', `${minutes} хв.`].filter(Boolean).join(' ');
}

function formatDateTime(value: string, timezone: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('uk-UA', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
