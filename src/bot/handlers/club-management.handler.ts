import { Context, Markup, Telegraf } from 'telegraf';
import { ClubCreationRequestRepository } from '../../storage/repositories/club-creation-request.repository';
import { ClubRepository } from '../../storage/repositories/club.repository';
import { createClubSlug } from '../../storage/clubSlug';
import { CallbackAuthorizationService } from '../authorization/callback-authorization.service';
import { logger } from '../../utils/logger';
import { SessionContextService, SessionMode } from '../session/session-context.service';
import { ClubHealthService } from '../../domain/clubs/club-health.service';
import { ClubHealth } from '../../domain/clubs/club.types';
import { AdminCallbacks } from '../admin/callbacks/admin-callbacks';
import { callbackButton } from '../callback-data';
import { isTelegramUserClubAdmin } from '../../domain/settings/club-admin-authorization';
import { AdminNavigationService } from '../navigation/admin-navigation.service';
import { getRootScreen, NavigationScreens } from '../navigation/admin-navigation.service';
import { ClubDiagnostics } from '../../domain/clubs/club-diagnostics.service';

type Session =
    | { state: 'user_name' | 'super_name'; requestId?: string }
    | { state: 'user_confirm' | 'super_confirm'; clubName: string; slug: string; requestId?: string }
    | { state: 'add_admin'; clubId: string }
    | { state: 'super_club_select' | 'super_club_search' }
    | { state: 'super_delete_confirm'; clubId: string; clubName: string };

type PreparedClubContext = {
    clubId: string;
    title: string;
    storageSlug: string;
    directoryPath: string;
    settingsPath: string;
    settingsClubId: string;
};

export class ClubManagementHandler {
    private readonly sessions = new Map<number, Session>();
    private readonly clubLoadFailures = new Map<string, unknown>();

    constructor(
        private readonly bot: Telegraf,
        private readonly clubs: ClubRepository,
        private readonly requests: ClubCreationRequestRepository,
        private readonly superAdminIds: readonly number[],
        private readonly authorization: CallbackAuthorizationService,
        private readonly sessionContexts: SessionContextService,
        private readonly health: ClubHealthService,
        private readonly navigation?: AdminNavigationService,
        private readonly prepareClubContext?: (clubId: string) => Promise<PreparedClubContext>,
        private readonly renderClubRoot?: (ctx: Context, clubId: string) => Promise<void>,
        private readonly invalidateClubContext?: (clubId: string) => void,
        private readonly diagnoseClub?: (clubId: string) => Promise<ClubDiagnostics>,
    ) {}

    async handleStart(ctx: Context): Promise<boolean> {
        if (!ctx.from || ctx.chat?.type !== 'private') return false;
        const existingRoot = getRootScreen(this.sessionContexts.get(ctx.from.id));
        if (existingRoot === NavigationScreens.CLUB_ADMIN_ROOT) return false;
        if (existingRoot === NavigationScreens.SUPER_ADMIN_ROOT) return this.showSuperAdminMenu(ctx);
        if (this.authorization.isSuperAdmin(ctx.from.id)) {
            this.sessionContexts.enterSuperAdmin(ctx.from.id);
            await this.showSuperAdminEntry(ctx);
            return true;
        }
        // Registry loading may persist a legacy migration, so keep these reads ordered.
        const adminClubs = await this.clubs.findAdminClubs(ctx.from.id);
        const memberClubs = await this.clubs.findMemberClubs(ctx.from.id);
        const availableClubs = [...new Map([...adminClubs, ...memberClubs].map((club) => [club.id, club])).values()];
        if (availableClubs.length > 1) return this.showUserClubSelection(ctx, availableClubs);
        if (availableClubs.length === 1 && adminClubs.some((club) => club.id === availableClubs[0].id)) {
            const club = availableClubs[0];
            try { await this.prepareClubContext?.(club.id); }
            catch (error) { this.clubLoadFailures.set(club.id, error); return this.showClubLoadFailure(ctx, club.id, club.name, club.shortId); }
            this.sessionContexts.enterClubAdmin(ctx.from.id, club);
            return false;
        }
        if (availableClubs.length === 1) {
            this.sessionContexts.enterClubUser(ctx.from.id, availableClubs[0]);
            return this.showClubUserContext(ctx, availableClubs[0]);
        }
        this.sessions.delete(ctx.from.id);
        this.sessionContexts.clear(ctx.from.id);
        await ctx.reply('👋 Вітаємо!\n\nСхоже, ви ще не належите до жодного клубу.\n\nОберіть, що бажаєте зробити.', Markup.inlineKeyboard([
            [Markup.button.callback('🏸 Приєднатися до клубу', 'onboarding:join')],
            [Markup.button.callback('➕ Створити новий клуб', 'onboarding:create')],
        ]));
        return true;
    }

    async handleCallback(ctx: Context): Promise<boolean> {
        if (!ctx.from || ctx.chat?.type !== 'private' || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return false;
        const callback = ctx.callbackQuery.data;
        if (callback !== AdminCallbacks.MainMenu && !callback.startsWith('cr:') && !callback.startsWith('superadmin:') && !callback.startsWith('mode:') && !callback.startsWith('system:') && !callback.startsWith('onboarding:') && !callback.startsWith('clubs:') && !callback.startsWith('club:')) return false;
        if (callback === AdminCallbacks.MainMenu) {
            const root = getRootScreen(this.sessionContexts.get(ctx.from.id));
            if (root === NavigationScreens.CLUB_ADMIN_ROOT) return false;
            if (root === NavigationScreens.SUPER_ADMIN_ROOT) return this.showSuperAdminMenu(ctx);
            return this.handleStart(ctx);
        }
        const currentMode = this.sessionContexts.get(ctx.from.id)?.mode;
        const isSuperUiCallback = callback.startsWith('superadmin:') || callback.startsWith('system:') || callback.startsWith('clubs:') || callback.startsWith('club:');
        if (isSuperUiCallback && currentMode !== SessionMode.SUPER_ADMIN) { await ctx.answerCbQuery('⚠️ Це меню вже неактивне.'); return true; }
        if ((callback === 'mode:club_select' || callback.startsWith('mode:club:')) && currentMode !== SessionMode.SUPER_ADMIN) { await ctx.answerCbQuery('⚠️ Це меню вже неактивне.'); return true; }
        if (callback === 'mode:super' && currentMode !== SessionMode.CLUB_ADMIN) { await ctx.answerCbQuery('⚠️ Це меню вже неактивне.'); return true; }
        const requiredAccess = this.authorization.requiredAccess(callback);
        const activeClubId = this.clubIdFromCallback(callback);
        if (!await this.authorization.canAccessCallback({ telegramUserId: ctx.from.id, callback, activeClubId, requiredAccess })) {
            logger.warn('telegram.callback_access_denied', { telegramUserId: ctx.from.id, callback, requiredAccess, activeClubId, matchedHandler: this.constructor.name });
            try { await ctx.answerCbQuery('⛔ У вас немає доступу до цієї дії.', { show_alert: true }); }
            catch { await ctx.reply('⛔ У вас немає доступу до цієї дії.'); }
            return true;
        }
        try { await ctx.answerCbQuery(); } catch { /* expired callback */ }

        if (callback === 'superadmin:menu') return this.showSuperAdminMenu(ctx);
        if (callback === 'superadmin:clubs') return this.showRegisteredClubs(ctx);
        if (callback === 'superadmin:clubs:search') { this.sessions.set(ctx.from.id, { state: 'super_club_search' }); await ctx.reply('🔎 Введіть назву, slug, Club ID або Telegram ID адміністратора.'); return true; }
        if (callback === 'superadmin:activity') return this.showActivity(ctx);
        const activityFilter = callback.match(/^superadmin:activity:(active|setup_required|inactive|disabled|broken)$/);
        if (activityFilter) return this.renderClubResults(ctx, (await this.health.inspectAll()).filter((item) => item.status === activityFilter[1]), `📊 ${statusLabel(activityFilter[1] as ClubHealth['status'])}`);
        if (callback === 'superadmin:problems') return this.showProblems(ctx);
        if (callback === 'superadmin:club:create') return this.startSuperCreation(ctx);
        const superClubMatch = callback.match(/^superadmin:club:(view|open|retry|diag|disable|enable|delete):([a-zA-Z0-9]+)$/);
        if (superClubMatch) return this.handleSuperClubAction(ctx, superClubMatch[1], superClubMatch[2]);

        if (callback === 'mode:club_select') return this.showClubModeSelection(ctx);
        const clubModeMatch = callback.match(/^mode:club:(.+)$/);
        if (clubModeMatch) return this.enterClubByShortId(ctx, clubModeMatch[1]);
        if (callback === 'mode:super') { await this.switchToSuperAdmin(ctx); return true; }
        if (callback === 'system:users') { await ctx.reply('👤 Користувачі'); return true; }
        if (callback === 'system:settings') { await ctx.reply('⚙️ Система'); return true; }
        if (callback === 'system:statistics') { await ctx.reply('📊 Статистика'); return true; }

        if (callback === 'onboarding:start') return this.handleStart(ctx).then(() => true as const);
        const onboardingClubMatch = callback.match(/^onboarding:club:(.+)$/);
        if (onboardingClubMatch) return this.enterUserClubByShortId(ctx, onboardingClubMatch[1]);
        if (callback === 'onboarding:join') return this.showJoinClubs(ctx);
        if (callback === 'onboarding:create' || callback === AdminCallbacks.ClubRequestCreate) return this.startUserCreation(ctx);
        if (callback === AdminCallbacks.ClubRequestConfirm) return this.submitRequest(ctx);
        if (callback === AdminCallbacks.ClubRequestEdit) return this.startUserCreation(ctx);
        if (callback === AdminCallbacks.ClubRequestCancel) { this.sessions.delete(ctx.from.id); await ctx.reply('Створення клубу скасовано.'); return true; }

        if (callback === 'clubs:menu') return this.showClubsMenu(ctx);
        if (callback === 'clubs:list') return this.showClubList(ctx);
        if (callback === 'club:create') return this.startSuperCreation(ctx);
        if (callback === 'club:create:confirm') return this.createImmediately(ctx);
        if (callback === 'club:create:cancel') { this.sessions.delete(ctx.from.id); return this.showClubsMenu(ctx); }
        if (callback === AdminCallbacks.ClubRequestList) return this.showRequests(ctx);

        const ownedRequestMatch = callback.match(/^cr:(e|c):([A-Za-z0-9_-]+)$/);
        if (ownedRequestMatch) {
            const owned = await this.requests.findByShortId(ownedRequestMatch[2]);
            if (!owned) { await ctx.reply('⚠️ Це меню вже неактивне.'); return true; }
            if (!owned || owned.status !== 'pending' || (!this.authorization.isSuperAdmin(ctx.from.id) && Number(owned.requesterTelegramId) !== Number(ctx.from.id))) {
                await ctx.reply('⛔ У вас немає доступу до цієї заявки.'); return true;
            }
            if (ownedRequestMatch[1] === 'e') return this.startUserCreation(ctx, owned.id);
            await this.requests.delete(owned.id);
            await ctx.reply('Заявку скасовано.');
            return true;
        }

        const settingsMatch = callback.match(/^club:settings:(.+)$/);
        if (settingsMatch) return this.showClubSettings(ctx, settingsMatch[1]);

        const requestMatch = callback.match(/^cr:(v|a|r):([A-Za-z0-9_-]+)$/);
        if (requestMatch) {
            const request = await this.requests.findByShortId(requestMatch[2]);
            if (!request) { await ctx.reply('⚠️ Це меню вже неактивне.'); return true; }
            if (requestMatch[1] === 'v') return this.showRequest(ctx, request.id);
            if (requestMatch[1] === 'a') return this.approve(ctx, request.id);
            return this.reject(ctx, request.id);
        }
        const deleteMatch = callback.match(/^club:delete:confirm:(.+)$/);
        if (deleteMatch) return this.deleteClub(ctx, deleteMatch[1]);
        const removeConfirmMatch = callback.match(/^club:removeadmin:confirm:([^:]+):(\d+)$/);
        if (removeConfirmMatch) return this.removeAdmin(ctx, removeConfirmMatch[1], Number(removeConfirmMatch[2]));
        const clubMatch = callback.match(/^club:(view|delete|admins|addadmin):([^:]+)$/);
        if (clubMatch) {
            if (clubMatch[1] === 'view') return this.showClub(ctx, clubMatch[2]);
            if (clubMatch[1] === 'delete') return this.confirmDelete(ctx, clubMatch[2]);
            if (clubMatch[1] === 'admins') return this.showAdmins(ctx, clubMatch[2]);
            return this.startAddAdmin(ctx, clubMatch[2]);
        }
        const removeMatch = callback.match(/^club:removeadmin:([^:]+):(\d+)$/);
        if (removeMatch) return this.confirmRemoveAdmin(ctx, removeMatch[1], Number(removeMatch[2]));
        return true;
    }

    async handleMessage(ctx: Context): Promise<boolean> {
        if (!ctx.from || ctx.chat?.type !== 'private' || !ctx.message || !('text' in ctx.message)) return false;
        const session = this.sessions.get(ctx.from.id);
        if (!session) return false;
        const text = ctx.message.text.trim();
        if (session.state === 'user_name' || session.state === 'super_name') {
            if (!text) { await ctx.reply('Введіть непорожню назву клубу.'); return true; }
            const slug = createClubSlug(text);
            if (await this.clubs.findBySlug(slug)) { await ctx.reply('Клуб із такою назвою вже існує. Введіть іншу назву.'); return true; }
            const superFlow = session.state === 'super_name';
            this.sessions.set(ctx.from.id, { state: superFlow ? 'super_confirm' : 'user_confirm', clubName: text, slug, requestId: session.requestId });
            await ctx.reply(`🏸 Назва клубу\n\n${text}\n\n${superFlow ? 'Створити клуб?' : 'Надіслати заявку?'}`, Markup.inlineKeyboard([
                [Markup.button.callback(superFlow ? '✅ Створити' : '✅ Надіслати', superFlow ? 'club:create:confirm' : AdminCallbacks.ClubRequestConfirm)],
                [Markup.button.callback('✏️ Змінити', superFlow ? 'club:create' : AdminCallbacks.ClubRequestEdit)],
                [Markup.button.callback('❌ Скасувати', superFlow ? 'club:create:cancel' : AdminCallbacks.ClubRequestCancel)],
            ]));
            return true;
        }
        if (session.state === 'add_admin') {
            if (!await this.authorization.canAccess({ telegramUserId: ctx.from.id, requiredAccess: 'super_admin' })) { await ctx.reply('⛔ У вас немає доступу до цієї дії.'); return true; }
            const telegramId = await this.clubs.findUserTelegramId(text);
            if (!telegramId) { await ctx.reply('Користувача не знайдено. Введіть Telegram ID, @username або точне ім’я наявного гравця.'); return true; }
            const club = await this.clubs.addAdmin(session.clubId, telegramId);
            this.sessions.delete(ctx.from.id);
            await this.safeSend(telegramId, `Вас призначено адміністратором клубу "${club.name}".`);
            return this.showAdmins(ctx, club.id);
        }
        if (session.state === 'super_club_select') {
            const selected = Number(text);
            const clubs = await this.health.inspectAll();
            if (!Number.isInteger(selected) || selected < 1 || selected > clubs.length) { await ctx.reply('Введіть номер клубу зі списку.'); return true; }
            this.sessions.delete(ctx.from.id); return this.showSuperClubDetails(ctx, clubs[selected - 1]);
        }
        if (session.state === 'super_club_search') {
            const query = text.replace(/^@/, '').toLocaleLowerCase('uk');
            const numeric = Number(query);
            const clubs = (await this.health.inspectAll()).filter(({ club }) => club.name.toLocaleLowerCase('uk').includes(query) || club.slug.toLocaleLowerCase('uk').includes(query) || club.id.toLocaleLowerCase('uk').includes(query) || isTelegramUserClubAdmin(club.admins, numeric));
            this.sessions.delete(ctx.from.id); return this.renderClubResults(ctx, clubs, '🔎 Результати пошуку');
        }
        if (session.state === 'super_delete_confirm') {
            if (text !== session.clubName) { await ctx.reply(`Назва не збігається. Для видалення введіть точно:\n${session.clubName}`); return true; }
            const backup = await this.clubs.backupAndDelete(session.clubId);
            this.invalidateClubContext?.(session.clubId);
            this.sessions.delete(ctx.from.id); await ctx.reply(`Клуб видалено. Резервна копія: ${backup}`); return this.showRegisteredClubs(ctx);
        }
        return false;
    }

    private async startUserCreation(ctx: Context, requestId?: string): Promise<true> {
        const id = ctx.from!.id;
        if (!requestId && (await this.requests.findByRequester(id)).some((request) => request.status === 'pending')) { await ctx.reply('У вас уже є заявка, що очікує розгляду.'); return true; }
        this.sessions.set(id, { state: 'user_name', requestId });
        await ctx.reply(['🏸 Створення нового клубу', '', 'Введіть назву вашого клубу.', '', 'Після цього заявка буде надіслана на перевірку адміністратору.', '', 'Після підтвердження ви автоматично станете адміністратором цього клубу.'].join('\n'));
        return true;
    }

    private async submitRequest(ctx: Context): Promise<true> {
        const session = this.sessions.get(ctx.from!.id);
        if (!session || session.state !== 'user_confirm') { await ctx.reply('Заявка вже надіслана або дані застаріли.'); return true; }
        if (!session.requestId && (await this.requests.findByRequester(ctx.from!.id)).some((request) => request.status === 'pending')) { this.sessions.delete(ctx.from!.id); await ctx.reply('У вас уже є заявка, що очікує розгляду.'); return true; }
        if (await this.clubs.findBySlug(session.slug)) { await ctx.reply('Клуб із такою назвою вже існує. Змініть назву.'); return true; }
        const existing = session.requestId ? await this.requests.findById(session.requestId) : undefined;
        const request = existing
            ? await this.requests.save({ ...existing, clubName: session.clubName, slug: session.slug })
            : await this.requests.create({
                clubName: session.clubName, slug: session.slug, requesterTelegramId: ctx.from!.id,
                requesterDisplayName: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' '),
                requesterUsername: ctx.from!.username,
            });
        this.sessions.delete(ctx.from!.id);
        await ctx.reply('✅ Заявку надіслано. Ми повідомимо вас після її розгляду.');
        const text = this.requestText(request);
        for (const adminId of this.superAdminIds) await this.safeSend(adminId, text, Markup.inlineKeyboard([[callbackButton('✅ Підтвердити', `${AdminCallbacks.ClubRequestApprovePrefix}${request.shortId}`, AdminCallbacks.ClubRequestApprovePrefix, 'ClubCreationRequest'), callbackButton('❌ Відхилити', `${AdminCallbacks.ClubRequestRejectPrefix}${request.shortId}`, AdminCallbacks.ClubRequestRejectPrefix, 'ClubCreationRequest')]]));
        return true;
    }

    private async showClubsMenu(ctx: Context): Promise<true> { await ctx.reply('🏸 Клуби', Markup.inlineKeyboard([[Markup.button.callback('📋 Список клубів', 'clubs:list')], [Markup.button.callback('➕ Створити клуб', 'club:create')], [Markup.button.callback('📥 Заявки на клуби', AdminCallbacks.ClubRequestList)]])); return true; }
    private async showSuperAdminEntry(ctx: Context): Promise<true> { if ((await this.clubs.findAll()).length === 0) { await ctx.reply('🌐 Суперадміністратор\n\nКлубів поки немає.', Markup.inlineKeyboard([[Markup.button.callback('➕ Створити клуб', 'superadmin:club:create')], [Markup.button.callback('📥 Заявки на створення', AdminCallbacks.ClubRequestList)]])); return true; } await ctx.reply('🌐 Суперадміністратор', Markup.inlineKeyboard([[Markup.button.callback('🌐 Панель суперадміністратора', 'superadmin:menu')], [Markup.button.callback('🏸 Перейти до клубу', 'mode:club_select')]])); return true; }
    private async showSuperAdminMenu(ctx: Context): Promise<true> { const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🏸 Клуби', 'superadmin:clubs')], [Markup.button.callback('📥 Заявки на створення', AdminCallbacks.ClubRequestList)], [Markup.button.callback('📊 Активність клубів', 'superadmin:activity')], [Markup.button.callback('⚠️ Проблеми', 'superadmin:problems')], [Markup.button.callback('➕ Створити клуб', 'superadmin:club:create')], [Markup.button.callback('🔄 Перейти до клубу', 'mode:club_select')]]); if (this.navigation) await this.navigation.freshRoot(ctx, '🌐 Суперадміністратор', keyboard); else await ctx.reply('🌐 Суперадміністратор', keyboard); return true; }
    private async showRegisteredClubs(ctx: Context): Promise<true> { const clubs = await this.health.inspectAll(); if (!clubs.length) { await ctx.reply('🏸 Клубів поки немає.\n\nВи можете створити перший клуб або переглянути заявки користувачів.', Markup.inlineKeyboard([[Markup.button.callback('➕ Створити клуб', 'superadmin:club:create')], [Markup.button.callback('📥 Заявки', AdminCallbacks.ClubRequestList)], [Markup.button.callback('◀️ Назад', 'superadmin:menu')]])); return true; } this.sessions.set(ctx.from!.id, { state: 'super_club_select' }); return this.renderClubResults(ctx, clubs, `🏸 Клуби (${clubs.length})`); }
    private async renderClubResults(ctx: Context, clubs: ClubHealth[], title: string): Promise<true> { if (!clubs.length) { await ctx.reply(`${title}\n\nНічого не знайдено.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'superadmin:menu')]])); return true; } const lines = clubs.map((item, index) => `${index + 1}. ${item.club.name}\n   ${item.dataAvailable === false ? '🔴 Помилка завантаження' : `${item.readinessReady ? '🟢 Готовий' : '🟡 Потрібне налаштування'} · ${item.chats} чатів · ${item.templateCount ?? item.enabledTemplates} записів розкладу`}`); await ctx.reply(`${title}\n\n${lines.join('\n\n')}\n\nВведіть номер клубу.`, Markup.inlineKeyboard([[Markup.button.callback('➕ Створити клуб', 'superadmin:club:create'), Markup.button.callback('🔎 Пошук', 'superadmin:clubs:search')], [Markup.button.callback('📊 Активність', 'superadmin:activity')], [Markup.button.callback('◀️ Назад', 'superadmin:menu')]])); return true; }
    private async showActivity(ctx: Context): Promise<true> { const clubs = await this.health.inspectAll(); const count = (status: ClubHealth['status']) => clubs.filter((item) => item.status === status).length; await ctx.reply(`📊 Активність клубів\n\n🟢 Активні: ${count('active')}\n🟡 Потребують налаштування: ${count('setup_required')}\n🔴 Неактивні: ${count('inactive')}\n⚠️ Пошкоджені: ${count('broken')}\n⛔ Вимкнені: ${count('disabled')}`, Markup.inlineKeyboard([[Markup.button.callback('🟢 Активні', 'superadmin:activity:active')], [Markup.button.callback('🟡 Не налаштовані', 'superadmin:activity:setup_required')], [Markup.button.callback('🔴 Неактивні', 'superadmin:activity:inactive')], [Markup.button.callback('⚠️ Проблеми', 'superadmin:problems')], [Markup.button.callback('◀️ Назад', 'superadmin:menu')]])); return true; }
    private async showProblems(ctx: Context): Promise<true> { const clubs = (await this.health.inspectAll()).filter((item) => item.problems.length || ['broken', 'setup_required'].includes(item.status)); const text = clubs.length ? clubs.map((item, index) => `${index + 1}. ${item.club.name}\n   ${item.problems.join('; ') || statusLabel(item.status)}`).join('\n\n') : 'Проблем не виявлено.'; await ctx.reply(`⚠️ Проблеми\n\n${text}`, Markup.inlineKeyboard([...clubs.slice(0, 8).map((item) => [Markup.button.callback(`🏸 ${item.club.name}`, `superadmin:club:view:${item.club.shortId}`)]), [Markup.button.callback('◀️ Назад', 'superadmin:menu')]])); return true; }
    private async handleSuperClubAction(ctx: Context, action: string, shortId: string): Promise<true> { const club = await this.clubs.findByShortId(shortId); if (!club) { await ctx.reply('Клуб не знайдено в центральному реєстрі.'); return true; } if (action === 'open') return this.enterClubMode(ctx, club.id); if (action === 'retry') { this.invalidateClubContext?.(club.id); return this.enterClubMode(ctx, club.id); } if (action === 'diag') return this.showClubLoadDiagnostics(ctx, club.id, club.name, shortId); if (action === 'disable') { await this.clubs.disable(club.id); this.invalidateClubContext?.(club.id); return this.showSuperClubDetails(ctx, await this.health.inspect({ ...club, status: 'disabled', disabledAt: new Date().toISOString() })); } if (action === 'enable') { const enabled = await this.clubs.enable(club.id); this.invalidateClubContext?.(club.id); return this.showSuperClubDetails(ctx, await this.health.inspect(enabled)); } if (action === 'delete') { this.sessions.set(ctx.from!.id, { state: 'super_delete_confirm', clubId: club.id, clubName: club.name }); await ctx.reply(`⚠️ Щоб видалити клуб і створити резервну копію, введіть точну назву:\n\n${club.name}`); return true; } return this.showSuperClubDetails(ctx, await this.health.inspect(club)); }
    private async showSuperClubDetails(ctx: Context, item: ClubHealth): Promise<true> { const last = item.club.lastActivityAt ? new Date(item.club.lastActivityAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) : 'немає'; const scheduler = item.schedulerStatus === 'healthy' ? '🟢 Справний' : item.schedulerStatus === 'partial' ? '🟡 Частково працює' : item.schedulerStatus === 'failed' ? '🔴 Не працює' : '— Не налаштований'; const counts = item.dataAvailable === false ? 'Дані клубу: ⚠️ недоступні' : `Чатів: ${item.chats}\nШаблонів: ${item.templateCount ?? item.enabledTemplates}\nГравців: ${item.playerCount ?? 0}\nТренувань: ${item.trainingCount ?? 0}\nАктивних тренувань: ${item.activeTrainings}`; await ctx.reply(`🏸 ${item.club.name}\n\nСтатус: ${statusLabel(item.status)}\nАдміністраторів: ${item.club.admins.length}\n${counts}\nОстання активність: ${last}\n\nСховище: ${item.status === 'broken' ? 'пошкоджене' : 'справне'}\nScheduler: ${scheduler} · ${item.restoredSchedulerJobs}/${item.expectedSchedulerJobs} jobs${item.problems.length ? `\n\n⚠️ ${item.problems.join('\n⚠️ ')}` : ''}`, Markup.inlineKeyboard([[Markup.button.callback('🔄 Відкрити як адміністратора', `superadmin:club:open:${item.club.shortId}`)], [Markup.button.callback('⚙️ Системні дані', `club:settings:${item.club.id}`)], [Markup.button.callback('📊 Активність', 'superadmin:activity')], [Markup.button.callback(item.status === 'disabled' ? '▶️ Увімкнути' : '⏸ Вимкнути', `superadmin:club:${item.status === 'disabled' ? 'enable' : 'disable'}:${item.club.shortId}`)], [Markup.button.callback('🗑 Видалити клуб', `superadmin:club:delete:${item.club.shortId}`)], [Markup.button.callback('◀️ До списку', 'superadmin:clubs')]])); return true; }
    private async showClubModeSelection(ctx: Context): Promise<true> { const clubs = await this.clubs.findAll(); if (!clubs.length) { await ctx.reply('Клубів поки немає.', Markup.inlineKeyboard([[Markup.button.callback('➕ Створити клуб', 'superadmin:club:create')], [Markup.button.callback('⬅️ Назад', 'superadmin:menu')]])); return true; } const keyboard = Markup.inlineKeyboard(clubs.map((club) => [Markup.button.callback(`🏸 ${club.name}`, `mode:club:${club.shortId}`)])); if (this.navigation) await this.navigation.showFresh(ctx, 'Оберіть клуб', keyboard); else await ctx.reply('Оберіть клуб', keyboard); return true; }
    private async showJoinClubs(ctx: Context): Promise<true> { const clubs = (await this.clubs.findAll()).filter((club) => club.status !== 'disabled'); if (!clubs.length) { await ctx.reply('🏸 Поки що немає доступних клубів.\n\nВи можете створити власний клуб.', Markup.inlineKeyboard([[Markup.button.callback('➕ Створити новий клуб', 'onboarding:create')], [Markup.button.callback('⬅️ Назад', 'onboarding:start')]])); return true; } return this.showUserClubSelection(ctx, clubs); }
    private async showUserClubSelection(ctx: Context, clubs: Awaited<ReturnType<ClubRepository['findAll']>>): Promise<true> { await ctx.reply('Оберіть клуб', Markup.inlineKeyboard(clubs.map((club) => [Markup.button.callback(`🏸 ${club.name}`, `onboarding:club:${club.shortId}`)]))); return true; }
    private async enterClubByShortId(ctx: Context, token: string): Promise<true> { const club = await this.clubs.findByShortId(token) ?? await this.clubs.findById(token); if (!club) { await ctx.reply('Клуб не знайдено в центральному реєстрі.'); return true; } return this.enterClubMode(ctx, club.id); }
    private async enterUserClubByShortId(ctx: Context, token: string): Promise<true> { const club = await this.clubs.findByShortId(token) ?? await this.clubs.findById(token); if (!club) { await ctx.reply('Клуб не знайдено.'); return true; } return this.enterUserClub(ctx, club.id); }
    private async enterUserClub(ctx: Context, clubId: string): Promise<true> {
        const club = await this.clubs.findById(clubId);
        if (!club || !ctx.from) { await ctx.reply('Клуб не знайдено.'); return true; }
        if ((await this.clubs.findAdminClubs(ctx.from.id)).some((candidate) => candidate.id === club.id)) {
            return this.enterClubMode(ctx, club.id);
        }
        if (!await this.clubs.userBelongsToClubId(ctx.from.id, club.id)) { await ctx.reply('⛔ У вас немає доступу до цього клубу.'); return true; }
        this.sessionContexts.enterClubUser(ctx.from.id, club);
        return this.showClubUserContext(ctx, club);
    }
    private async showClubUserContext(ctx: Context, club: { id: string; name: string }): Promise<true> { await ctx.reply(`🏸 ${club.name}\n\nВи увійшли до клубу.`, Markup.inlineKeyboard([[Markup.button.callback('🏠 Головне меню', AdminCallbacks.MainMenu)]])); return true; }
    private async enterClubMode(ctx: Context, clubId: string): Promise<true> {
        const club = await this.clubs.findById(clubId);
        if (!club || !ctx.from) { await ctx.reply('Клуб не знайдено.'); return true; }
        const activeClubIdBefore = this.sessionContexts.get(ctx.from.id)?.activeClubId;
        logger.info('club.open_debug', { telegramUserId: ctx.from.id, selectedClubId: clubId, activeClubIdBefore, registryClubFound: true, registryClubId: club.id, title: club.name, storageSlug: club.slug, repositoriesLoaded: false });
        let prepared: PreparedClubContext | undefined;
        try {
            prepared = this.prepareClubContext ? await this.prepareClubContext(club.id) : undefined;
        } catch (error) {
            this.clubLoadFailures.set(club.id, error);
            logger.error('club.open_debug', { telegramUserId: ctx.from.id, selectedClubId: club.id, activeClubIdBefore, registryClubFound: true, registryClubId: club.id, title: club.name, storageSlug: club.slug, repositoriesLoaded: false, activeClubIdAfter: this.sessionContexts.get(ctx.from.id)?.activeClubId, reason: loadErrorCode(error) });
            return this.showClubLoadFailure(ctx, club.id, club.name, club.shortId);
        }
        this.clubLoadFailures.delete(club.id);
        if (this.navigation) {
            await this.navigation.switchMode(ctx, SessionMode.CLUB_ADMIN, club);
            if (this.renderClubRoot) await this.renderClubRoot(ctx, club.id); else await ctx.reply(`🏸 ${club.name}`);
        } else {
            this.sessionContexts.enterClubAdmin(ctx.from.id, club);
            await ctx.reply(`🏸 ${club.name}\n\nРежим адміністратора клубу`, Markup.inlineKeyboard([[Markup.button.callback('🏠 Відкрити меню клубу', 'm')], [Markup.button.callback('🌐 Режим суперадміністратора', 'mode:super')]]));
        }
        logger.info('club.open_debug', { telegramUserId: ctx.from.id, selectedClubId: club.id, activeClubIdBefore, registryClubFound: true, registryClubId: club.id, title: club.name, storageSlug: club.slug, directoryPath: prepared?.directoryPath, directoryExists: true, settingsPath: prepared?.settingsPath, settingsExists: true, settingsClubId: prepared?.settingsClubId, repositoriesLoaded: true, contextClubId: prepared?.clubId, activeClubIdAfter: this.sessionContexts.get(ctx.from.id)?.activeClubId });
        return true;
    }
    private async showClubLoadFailure(ctx: Context, clubId: string, clubName: string, shortId: string): Promise<true> { const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔄 Спробувати ще раз', `superadmin:club:retry:${shortId}`)], [Markup.button.callback('🩺 Діагностика', `superadmin:club:diag:${shortId}`)], [Markup.button.callback('◀️ До списку клубів', 'superadmin:clubs')]]); const text = `⚠️ Не вдалося завантажити дані клубу.\n\nКлуб:\n${clubName}`; if (this.navigation) await this.navigation.showFresh(ctx, text, keyboard); else await ctx.reply(text, keyboard); return true; }
    private async showClubLoadDiagnostics(ctx: Context, clubId: string, clubName: string, shortId: string): Promise<true> {
        const diagnostic = this.diagnoseClub ? await this.diagnoseClub(clubId) : undefined;
        const previous = this.clubLoadFailures.get(clubId);
        const text = diagnostic ? renderClubDiagnostics(clubName, diagnostic) : `🩺 ${clubName}\n\nПричина:\n${loadErrorLabel(previous)}\n\nТехнічна помилка:\n${safeTechnicalMessage(previous)}`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔄 Перевірити ще раз', `superadmin:club:diag:${shortId}`)], [Markup.button.callback('🔄 Спробувати відкрити', `superadmin:club:retry:${shortId}`)], [Markup.button.callback('◀️ Назад', 'superadmin:clubs')]]);
        if (this.navigation) await this.navigation.showFresh(ctx, text, keyboard); else await ctx.reply(text, keyboard);
        return true;
    }
    private async switchToSuperAdmin(ctx: Context): Promise<void> { if (this.navigation) await this.navigation.switchMode(ctx, SessionMode.SUPER_ADMIN); else { this.sessionContexts.enterSuperAdmin(ctx.from!.id); } await this.showSuperAdminMenu(ctx); }
    private async showClubList(ctx: Context): Promise<true> { const clubs = await this.clubs.findAll(); await ctx.reply(clubs.length ? '🏸 Клуби' : 'Клубів ще немає.', Markup.inlineKeyboard([...clubs.map((club) => [Markup.button.callback(`🏸 ${club.name}`, `club:view:${club.id}`)]), [Markup.button.callback('⬅️ Назад', 'clubs:menu')]])); return true; }
    private async showClub(ctx: Context, id: string): Promise<true> { const club = await this.clubs.findById(id); if (!club) { await ctx.reply('Клуб не знайдено.'); return true; } await ctx.reply(`🏸 ${club.name}`, Markup.inlineKeyboard([[Markup.button.callback('🔄 Відкрити як адміністратора', `mode:club:${club.shortId}`)], [Markup.button.callback('⚙️ Налаштування', `club:settings:${id}`)], [Markup.button.callback('🗑 Видалити клуб', `club:delete:${id}`)], [Markup.button.callback('⬅️ Назад', 'clubs:list')]])); return true; }
    private async showClubSettings(ctx: Context, id: string): Promise<true> { const club = await this.clubs.findById(id); if (!club) { await ctx.reply('Клуб не знайдено.'); return true; } await ctx.reply(`⚙️ Налаштування клубу\n\nНазва: ${club.name}\nSlug: ${club.slug}\nClub ID: ${club.id}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `club:view:${id}`)]])); return true; }
    private async startSuperCreation(ctx: Context): Promise<true> { this.sessions.set(ctx.from!.id, { state: 'super_name' }); await ctx.reply('🏸 Створення клубу\n\nВведіть назву клубу.'); return true; }
    private async createImmediately(ctx: Context): Promise<true> { const session = this.sessions.get(ctx.from!.id); if (!session || session.state !== 'super_confirm') { await ctx.reply('Дані створення застаріли.'); return true; } const club = await this.clubs.create({ name: session.clubName, slug: session.slug, firstAdminTelegramId: ctx.from!.id }); this.sessions.delete(ctx.from!.id); return this.showClub(ctx, club.id); }
    private async showRequests(ctx: Context): Promise<true> { const requests = await this.requests.findPending(); await ctx.reply(requests.length ? '📥 Заявки на клуби' : 'Нових заявок немає.', Markup.inlineKeyboard([...requests.map((request) => [callbackButton(`🏸 ${request.clubName}`, `${AdminCallbacks.ClubRequestViewPrefix}${request.shortId}`, AdminCallbacks.ClubRequestViewPrefix, 'ClubCreationRequest')]), [Markup.button.callback('⬅️ Назад', 'clubs:menu')]])); return true; }
    private async showRequest(ctx: Context, id: string): Promise<true> { const request = await this.requests.findById(id); if (!request) { await ctx.reply('Заявку не знайдено.'); return true; } if (!this.authorization.isSuperAdmin(ctx.from!.id) && Number(request.requesterTelegramId) !== Number(ctx.from!.id)) { await ctx.reply('⛔ У вас немає доступу до цієї заявки.'); return true; } await ctx.reply(this.requestText(request), request.status === 'pending' && this.authorization.isSuperAdmin(ctx.from!.id) ? Markup.inlineKeyboard([[callbackButton('✅ Підтвердити', `${AdminCallbacks.ClubRequestApprovePrefix}${request.shortId}`, AdminCallbacks.ClubRequestApprovePrefix, 'ClubCreationRequest'), callbackButton('❌ Відхилити', `${AdminCallbacks.ClubRequestRejectPrefix}${request.shortId}`, AdminCallbacks.ClubRequestRejectPrefix, 'ClubCreationRequest')], [Markup.button.callback('⬅️ Назад', AdminCallbacks.ClubRequestList)]]) : undefined); return true; }
    private async approve(ctx: Context, id: string): Promise<true> { const request = await this.requests.findById(id); if (!request || request.status !== 'pending') { await ctx.reply('Заявку вже розглянуто або не знайдено.'); return true; } if (await this.clubs.findBySlug(request.slug)) { await ctx.reply('Клуб із таким slug уже існує. Заявку не схвалено.'); return true; } const club = await this.clubs.create({ name: request.clubName, slug: request.slug, firstAdminTelegramId: request.requesterTelegramId }); await this.requests.approve(id, ctx.from!.id); await this.safeSend(request.requesterTelegramId, '✅ Ваш клуб успішно створено!\n\nТепер ви є адміністратором клубу.'); await this.safeSend(request.requesterTelegramId, `🏸 ${club.name}\n\nКерування клубом`, Markup.inlineKeyboard([[Markup.button.callback('⚙️ Відкрити Admin Menu', 'admin:main')]])); await ctx.reply('✅ Клуб створено, користувача повідомлено.'); return this.showRequest(ctx, id); }
    private async reject(ctx: Context, id: string): Promise<true> { const request = await this.requests.reject(id, ctx.from!.id); await this.safeSend(request.requesterTelegramId, '❌ На жаль, заявку на створення клубу було відхилено.\n\nЗа потреби ви можете подати нову заявку.'); await ctx.reply('Заявку відхилено, користувача повідомлено.'); return true; }
    private async confirmDelete(ctx: Context, id: string): Promise<true> { await ctx.reply('⚠️ Ви дійсно бажаєте видалити клуб?\n\nЦя дія видалить усі дані та є незворотною.', Markup.inlineKeyboard([[Markup.button.callback('🗑 Так, видалити', `club:delete:confirm:${id}`)], [Markup.button.callback('❌ Скасувати', `club:view:${id}`)]])); return true; }
    private async deleteClub(ctx: Context, id: string): Promise<true> { await this.clubs.delete(id); this.invalidateClubContext?.(id); await ctx.reply('Клуб і всі його дані видалено.'); return this.showClubList(ctx); }
    private async showAdmins(ctx: Context, id: string): Promise<true> { const club = await this.clubs.findById(id); if (!club) { await ctx.reply('Клуб не знайдено.'); return true; } await ctx.reply(`👥 Адміністратори клубу “${club.name}”\n\n${club.admins.map((admin) => `👤 ${admin.telegramUserId}${admin.role === 'owner' ? ' · owner' : ''}`).join('\n')}`, Markup.inlineKeyboard([[Markup.button.callback('➕ Додати адміністратора', `club:addadmin:${id}`)], ...club.admins.map((admin) => [Markup.button.callback(`➖ ${admin.telegramUserId}`, `club:removeadmin:${id}:${admin.telegramUserId}`)]), [Markup.button.callback('⬅️ Назад', `club:view:${id}`)]])); return true; }
    private async startAddAdmin(ctx: Context, id: string): Promise<true> { this.sessions.set(ctx.from!.id, { state: 'add_admin', clubId: id }); await ctx.reply('Введіть Telegram ID, @username або точне ім’я наявного гравця.'); return true; }
    private async confirmRemoveAdmin(ctx: Context, clubId: string, telegramId: number): Promise<true> { const club = await this.clubs.findById(clubId); if (!club) { await ctx.reply('Клуб не знайдено.'); return true; } if (club.admins.length <= 1) { await ctx.reply('Не можна видалити останнього адміністратора.'); return true; } await ctx.reply(`Видалити адміністратора ${telegramId} з клубу “${club.name}”?`, Markup.inlineKeyboard([[Markup.button.callback('➖ Видалити', `club:removeadmin:confirm:${clubId}:${telegramId}`)], [Markup.button.callback('❌ Скасувати', `club:admins:${clubId}`)]])); return true; }
    private async removeAdmin(ctx: Context, clubId: string, telegramId: number): Promise<true> { try { const club = await this.clubs.removeAdmin(clubId, telegramId); await this.safeSend(telegramId, `Вас видалено з адміністраторів клубу "${club.name}".`); return this.showAdmins(ctx, clubId); } catch (error) { await ctx.reply(error instanceof Error ? error.message : 'Не вдалося видалити адміністратора.'); return true; } }
    private requestText(request: { clubName: string; requesterDisplayName: string; requesterUsername?: string; requesterTelegramId: number }): string { return `🏸 Нова заявка на створення клубу\n\nНазва:\n${request.clubName}\n\nКористувач:\n${request.requesterDisplayName}\n\nUsername:\n${request.requesterUsername ? `@${request.requesterUsername}` : '—'}\n\nTelegram ID:\n${request.requesterTelegramId}`; }
    private clubIdFromCallback(callback: string): string | undefined {
        if (callback.startsWith('cr:')) return undefined;
        const match = callback.match(/^club:(?:view|delete(?::confirm)?|admins|addadmin|removeadmin(?::confirm)?|settings):([^:]+)/);
        return match?.[1];
    }
    private async safeSend(chatId: number, text: string, extra?: Parameters<typeof this.bot.telegram.sendMessage>[2]): Promise<void> { try { await this.bot.telegram.sendMessage(chatId, text, extra); } catch { /* A user may not have started the bot yet. */ } }
}

function statusLabel(status: ClubHealth['status']): string {
    return status === 'active' ? '🟢 Активний' : status === 'setup_required' ? '🟡 Не налаштований' : status === 'inactive' ? '🔴 Неактивний' : status === 'disabled' ? '⛔ Вимкнений' : '🔴 Пошкоджений';
}

function loadErrorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'REPOSITORY_LOAD_FAILED'; }
function loadErrorLabel(error: unknown): string { switch (loadErrorCode(error)) { case 'CLUB_NOT_IN_REGISTRY': return 'Клуб не знайдено в реєстрі'; case 'STORAGE_NOT_FOUND': return 'Папку даних не знайдено'; case 'SETTINGS_NOT_FOUND': return 'Файл settings.json не знайдено'; case 'SETTINGS_INVALID': return 'Файл settings.json пошкоджено'; case 'CLUB_ID_MISMATCH': return 'settings.clubId не збігається з реєстром'; case 'STORAGE_SLUG_MISMATCH': return 'Папка клубу не збігається з реєстром'; default: return 'Не вдалося завантажити дані клубу'; } }
function safeTechnicalMessage(error: unknown): string { return error instanceof Error ? error.message : String(error ?? 'Причину не класифіковано'); }
function renderClubDiagnostics(name: string, value: ClubDiagnostics): string {
    const mark = (ok: boolean) => ok ? '✅' : '❌';
    const repositories = value.repositories;
    const lines = [`🩺 ${name}`, '', `Реєстр: ${mark(value.clubFound)}`, `Папка даних: ${mark(value.directoryExists)}`, `settings.json: ${mark(value.settingsExists && value.settingsValid !== false)}`, `clubId: ${mark(value.clubIdMatches !== false && Boolean(value.settingsClubId))}`, `Гравці: ${mark(repositories.players.valid)}`, `Чати: ${mark(repositories.chats.valid)}`, `Розклад: ${mark(repositories.schedule.valid)}`, `Тренування: ${mark(repositories.trainings.valid)}`];
    if (!value.failure) return [...lines, '', '✅ Дані клубу доступні.'].join('\n');
    const failure = value.failure;
    lines.push('', `❌ ${diagnosticReason(failure.code, failure.repository)}`);
    if (failure.code === 'CLUB_ID_MISMATCH') lines.push('', 'Registry:', value.registryClubId ?? '—', '', 'settings.json:', value.settingsClubId ?? '—');
    else if (failure.settingsPath) lines.push('', 'Шлях:', failure.settingsPath);
    else if (failure.directoryPath) lines.push('', `storageSlug: ${failure.storageSlug ?? '—'}`, `Шлях: ${failure.directoryPath}`);
    if (failure.technicalMessage) lines.push('', 'Помилка:', failure.technicalMessage);
    return lines.join('\n');
}
function diagnosticReason(code: string, repository?: string): string { switch (code) { case 'CLUB_NOT_FOUND': return 'Клуб не знайдено в реєстрі.'; case 'STORAGE_NOT_FOUND': return 'Не знайдено папку даних клубу.'; case 'SETTINGS_NOT_FOUND': return 'Не знайдено settings.json.'; case 'SETTINGS_INVALID': return 'settings.json містить некоректні дані.'; case 'CLUB_ID_MISMATCH': return 'clubId у settings.json не збігається з реєстром.'; case 'STORAGE_SLUG_MISMATCH': return 'storageSlug не збігається з реєстром.'; case 'REPOSITORY_CORRUPT': case 'REPOSITORY_LOAD_FAILED': return `Не вдалося завантажити сховище «${repository ?? 'невідоме'}».`; case 'CONTEXT_MISMATCH': return 'Завантажений контекст належить іншому клубу.'; default: return 'Невідома помилка завантаження.'; } }
