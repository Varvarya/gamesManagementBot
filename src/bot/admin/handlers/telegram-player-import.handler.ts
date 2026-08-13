import { randomBytes } from 'node:crypto';
import { Context, Markup } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TelegramPlayerImportService } from '../../../domain/telegram-import/telegram-player-import.service';
import { TelegramUserConnectionManager } from '../../../domain/telegram-import/telegram-user-connection.manager';
import { TelegramQrAuthError, TelegramQrAuthService, TelegramQrFailureReason } from '../../../domain/telegram-import/telegram-qr-auth.service';
import { TelegramGroupDialog } from '../../../tools/telegram-players-export/telegram-mtproto-loader';
import { isClubOwner } from '../../../domain/settings/club-admin-authorization';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { AdminFlowState } from '../flows/admin-flow.types';
import { createPlayersKeyboard } from '../keyboards/player.keyboard';
import { logger } from '../../../utils/logger';
import { safeTelegramErrorDetails } from '../../../domain/telegram-import/telegram-auth-error';

type DialogSelection = { clubId: string; ownerId: number; createdAt: number; values: Array<{ token: string; dialog: TelegramGroupDialog }> };

export class TelegramPlayerImportHandler {
    readonly messageStates: readonly AdminFlowState[] = ['waiting_telegram_qr_2fa_password'];
    private readonly dialogs = new Map<number, DialogSelection>();
    private readonly qrAttempts = new Map<number, { id: string; chatId: number; messageId?: number }>();

    constructor(
        private readonly services: ServicesContext,
        private readonly connections: TelegramUserConnectionManager,
        private readonly qrAuth: TelegramQrAuthService,
        private readonly imports: TelegramPlayerImportService,
        private readonly superAdminIds: readonly number[],
    ) {}

    canHandle(callback: string): boolean {
        return callback === AdminCallbacks.PlayerTelegramImport
            || callback === AdminCallbacks.PlayerTelegramConnect
            || callback.startsWith(AdminCallbacks.PlayerTelegramQrRefreshPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramQrCancelPrefix)
            || callback === AdminCallbacks.PlayerTelegramConnection
            || callback === AdminCallbacks.PlayerTelegramValidate
            || callback === AdminCallbacks.PlayerTelegramDisconnect
            || callback === AdminCallbacks.PlayerTelegramDisconnectConfirm
            || callback === AdminCallbacks.PlayerTelegramAddSource
            || callback.startsWith(AdminCallbacks.PlayerTelegramDialogPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramDialogPagePrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramSourcePrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramImportConfirmPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramImportCancelPrefix);
    }

    async handle(ctx: Context, callback: string): Promise<void> {
        if (!ctx.from) return;
        try {
            if (callback === AdminCallbacks.PlayerTelegramImport) return await this.showRoot(ctx);
            if (callback === AdminCallbacks.PlayerTelegramConnect) {
                if (!this.connections.configured) return await this.showError(ctx, 'Імпорт з Telegram не налаштовано на сервері.');
                return await this.startQr(ctx);
            }
            if (callback.startsWith(AdminCallbacks.PlayerTelegramQrRefreshPrefix)) return await this.refreshQr(ctx, callback.slice(AdminCallbacks.PlayerTelegramQrRefreshPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramQrCancelPrefix)) return await this.cancelQr(ctx, callback.slice(AdminCallbacks.PlayerTelegramQrCancelPrefix.length));
            if (callback === AdminCallbacks.PlayerTelegramConnection) return await this.showConnection(ctx);
            if (callback === AdminCallbacks.PlayerTelegramValidate) return await this.validate(ctx);
            if (callback === AdminCallbacks.PlayerTelegramDisconnect) return await this.confirmDisconnect(ctx);
            if (callback === AdminCallbacks.PlayerTelegramDisconnectConfirm) return await this.disconnect(ctx);
            if (callback === AdminCallbacks.PlayerTelegramAddSource) return await this.browseDialogs(ctx, 0, true);
            if (callback.startsWith(AdminCallbacks.PlayerTelegramDialogPagePrefix)) return await this.browseDialogs(ctx, Number(callback.slice(AdminCallbacks.PlayerTelegramDialogPagePrefix.length)), false);
            if (callback.startsWith(AdminCallbacks.PlayerTelegramDialogPrefix)) return await this.selectDialog(ctx, callback.slice(AdminCallbacks.PlayerTelegramDialogPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramSourcePrefix)) return await this.scan(ctx, callback.slice(AdminCallbacks.PlayerTelegramSourcePrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramImportConfirmPrefix)) return await this.commit(ctx, callback.slice(AdminCallbacks.PlayerTelegramImportConfirmPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramImportCancelPrefix)) return await this.cancel(ctx, callback.slice(AdminCallbacks.PlayerTelegramImportCancelPrefix.length));
        } catch (error) {
            logger.error('telegram_import.ui_failed', { clubId: this.clubId, telegramUserId: ctx.from.id, error });
            await this.showError(ctx, friendlyError(error));
        }
    }

    canHandleMessage(adminId: number): boolean { return this.messageStates.includes(this.services.adminFlow.getState(adminId)); }

    async handleMessage(ctx: Context): Promise<boolean> {
        if (!ctx.from || !ctx.message || !this.canHandleMessage(ctx.from.id)) return false;
        if (!('text' in ctx.message)) { await this.services.adminUi.notice(ctx, 'Надішліть текстове значення.'); return true; }
        const value = ctx.message.text.trim();
        await this.deleteSensitiveMessage(ctx);
        try {
            const attempt = this.qrAttempts.get(ctx.from.id); if (!attempt) throw new TelegramQrAuthError('QR_TOKEN_EXPIRED', 'password');
            await this.qrAuth.submitPassword(attempt.id, this.clubId, ctx.from.id, value);
        } catch (error) {
            this.logAuthFailure(ctx.from.id, error);
            await this.showError(ctx, qrUserMessage(error));
        }
        return true;
    }

    private get clubId(): string { return this.services.repositories.clubId; }

    private async startQr(ctx: Context): Promise<void> {
        const adminId = ctx.from!.id; const chatId = ctx.chat!.id;
        const presentation = await this.qrAuth.startQrLogin(this.clubId, adminId, this.qrEvents(ctx, adminId, chatId));
        if (ctx.callbackQuery) await ctx.deleteMessage().catch(() => undefined);
        const message = await ctx.replyWithPhoto({ source: presentation.png }, { caption: qrCaption(), ...qrKeyboard(presentation.id) });
        this.qrAttempts.set(adminId, { id: presentation.id, chatId, messageId: message.message_id });
        this.services.adminUi.trackBotMessage(adminId, chatId, message.message_id);
    }

    private async refreshQr(ctx: Context, attemptId: string): Promise<void> {
        const adminId = ctx.from!.id; const current = this.qrAttempts.get(adminId);
        if (!current || current.id !== attemptId) return this.showStaleQr(ctx);
        const presentation = await this.qrAuth.refreshQrLogin(attemptId, this.clubId, adminId, this.qrEvents(ctx, adminId, current.chatId));
        if (current.messageId) await ctx.telegram.deleteMessage(current.chatId, current.messageId).catch(() => undefined);
        const message = await ctx.telegram.sendPhoto(current.chatId, { source: presentation.png }, { caption: qrCaption(), ...qrKeyboard(presentation.id) });
        this.qrAttempts.set(adminId, { id: presentation.id, chatId: current.chatId, messageId: message.message_id });
        this.services.adminUi.trackBotMessage(adminId, current.chatId, message.message_id);
    }

    private async cancelQr(ctx: Context, attemptId: string): Promise<void> {
        const current = this.qrAttempts.get(ctx.from!.id); if (!current || current.id !== attemptId) return this.showStaleQr(ctx);
        await this.qrAuth.cancel(attemptId, this.clubId, ctx.from!.id, false); this.qrAttempts.delete(ctx.from!.id); this.services.adminFlow.finish(ctx.from!.id);
        if (current.messageId) await ctx.telegram.deleteMessage(current.chatId, current.messageId).catch(() => undefined);
        await ctx.telegram.sendMessage(current.chatId, 'Підключення скасовано.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', AdminCallbacks.PlayerTelegramImport)]]));
    }

    private qrEvents(ctx: Context, adminId: number, chatId: number) {
        return {
            onQr: async (presentation: { id: string; png: Buffer }) => {
                const current = this.qrAttempts.get(adminId); if (!current || current.id !== presentation.id || !current.messageId) return;
                await ctx.telegram.editMessageMedia(chatId, current.messageId, undefined, { type: 'photo', media: { source: presentation.png }, caption: qrCaption() }, qrKeyboard(presentation.id)).catch(() => undefined);
            },
            onPasswordRequired: async (attemptId: string) => {
                const current = this.qrAttempts.get(adminId); if (!current || current.id !== attemptId) return;
                this.services.adminFlow.start(adminId, 'waiting_telegram_qr_2fa_password');
                await ctx.telegram.sendMessage(chatId, '🔐 Для цього акаунта увімкнено двоетапну перевірку.\n\nНадішліть пароль.');
            },
            onPasswordInvalid: async (attemptId: string) => { const current = this.qrAttempts.get(adminId); if (!current || current.id !== attemptId) return; await ctx.telegram.sendMessage(chatId, '❌ Невірний пароль двоетапної перевірки.\n\nНадішліть пароль ще раз або скасуйте підключення.', Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramQrCancelPrefix}${attemptId}`)]])); },
            onCompleted: async (attemptId: string, connection: { displayName: string; username?: string }) => {
                const current = this.qrAttempts.get(adminId); if (!current || current.id !== attemptId) return;
                this.qrAttempts.delete(adminId); this.services.adminFlow.finish(adminId); if (current.messageId) await ctx.telegram.deleteMessage(chatId, current.messageId).catch(() => undefined);
                await ctx.telegram.sendMessage(chatId, ['✅ Telegram підключено', '', connection.displayName, connection.username ? `@${connection.username}` : ''].filter(Boolean).join('\n'), Markup.inlineKeyboard([[Markup.button.callback('💬 Обрати чат', AdminCallbacks.PlayerTelegramAddSource)], [Markup.button.callback('◀️ Назад', AdminCallbacks.PlayerTelegramImport)]]));
            },
            onExpired: async (attemptId: string) => { const current = this.qrAttempts.get(adminId); if (!current || current.id !== attemptId) return; await ctx.telegram.editMessageCaption(chatId, current.messageId, undefined, '⌛ QR-код більше неактуальний.', Markup.inlineKeyboard([[Markup.button.callback('🔄 Створити новий QR', `${AdminCallbacks.PlayerTelegramQrRefreshPrefix}${attemptId}`)], [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramQrCancelPrefix}${attemptId}`)]])).catch(() => undefined); },
            onFailed: async (attemptId: string, reason: TelegramQrFailureReason) => { const current = this.qrAttempts.get(adminId); if (!current || current.id !== attemptId) return; await ctx.telegram.editMessageCaption(chatId, current.messageId, undefined, `⚠️ ${qrReasonMessage(reason)}`, Markup.inlineKeyboard([[Markup.button.callback('🔄 Створити новий QR', `${AdminCallbacks.PlayerTelegramQrRefreshPrefix}${attemptId}`)], [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramQrCancelPrefix}${attemptId}`)]])).catch(() => undefined); },
        };
    }

    private async showStaleQr(ctx: Context): Promise<void> { await this.services.adminUi.show(ctx, '⚠️ Цей QR-код уже неактуальний.', Markup.inlineKeyboard([[Markup.button.callback('🔄 Створити новий', AdminCallbacks.PlayerTelegramConnect)], [Markup.button.callback('◀️ Назад', AdminCallbacks.PlayerTelegramImport)]])); }

    private async showRoot(ctx: Context): Promise<void> {
        if (this.messageStates.includes(this.services.adminFlow.getState(ctx.from!.id))) {
            const attempt = this.qrAttempts.get(ctx.from!.id); if (attempt) await this.qrAuth.cancel(attempt.id, this.clubId, ctx.from!.id, false).catch(() => undefined);
            this.qrAttempts.delete(ctx.from!.id);
            this.services.adminFlow.finish(ctx.from!.id);
        }
        const connection = await this.connections.getConnection(this.clubId);
        if (!connection) {
            const text = this.connections.configured
                ? '💬 Імпорт з Telegram\n\nДля імпорту учасників потрібен Telegram-акаунт адміністратора, який має доступ до потрібного чату.'
                : '💬 Імпорт з Telegram\n\nФункцію ще не налаштовано на сервері.';
            await this.services.adminUi.show(ctx, text, Markup.inlineKeyboard([...(this.connections.configured ? [[Markup.button.callback('🔗 Підключити Telegram', AdminCallbacks.PlayerTelegramConnect)]] : []), [Markup.button.callback('◀️ Назад', AdminCallbacks.Players)]]));
            return;
        }
        const sources = await this.connections.getSources(this.clubId);
        const owner = connection.telegramUserId === ctx.from!.id;
        await this.services.adminUi.show(ctx, ['💬 Імпорт з Telegram', '', ...(sources.length ? ['Оберіть чат:'] : ['Чатів для імпорту ще немає.']), connection.status === 'reauth_required' ? '\n⚠️ Підключення потребує повторної авторизації.' : ''].filter(Boolean).join('\n'), Markup.inlineKeyboard([
            ...sources.map((source) => [Markup.button.callback(source.title, `${AdminCallbacks.PlayerTelegramSourcePrefix}${source.shortId}`)]),
            ...(owner ? [[Markup.button.callback('➕ Додати чат', AdminCallbacks.PlayerTelegramAddSource)]] : []),
            [Markup.button.callback('⚙️ Підключення', AdminCallbacks.PlayerTelegramConnection)],
            [Markup.button.callback('◀️ Назад', AdminCallbacks.Players)],
        ]));
    }

    private async showConnection(ctx: Context): Promise<void> {
        const connection = await this.connections.getConnection(this.clubId);
        if (!connection) return this.showRoot(ctx);
        const status = connection.status === 'connected' ? '🟢 Активне' : '⚠️ Потрібна авторизація';
        await this.services.adminUi.show(ctx, `🔗 Telegram\n\nПідключено:\n${connection.displayName}\n\nСтатус: ${status}`, Markup.inlineKeyboard([
            ...(connection.telegramUserId === ctx.from!.id ? [[Markup.button.callback('💬 Обрати чат', AdminCallbacks.PlayerTelegramAddSource)]] : []),
            [Markup.button.callback('🔄 Перевірити підключення', AdminCallbacks.PlayerTelegramValidate)],
            [Markup.button.callback('🔄 Перепідключити', AdminCallbacks.PlayerTelegramConnect)],
            ...(await this.canDisconnect(ctx.from!.id) ? [[Markup.button.callback('🔌 Відключити', AdminCallbacks.PlayerTelegramDisconnect)]] : []),
            [Markup.button.callback('◀️ Назад', AdminCallbacks.PlayerTelegramImport)],
        ]));
    }

    private async validate(ctx: Context): Promise<void> { const connection = await this.connections.getConnection(this.clubId); if (!connection) return this.showRoot(ctx); await this.connections.validate(connection.id); await this.showConnection(ctx); }
    private async confirmDisconnect(ctx: Context): Promise<void> { if (!await this.canDisconnect(ctx.from!.id)) throw new Error('CONNECTION_PRIVACY_DENIED'); await this.services.adminUi.show(ctx, '🔌 Відключити Telegram від клубу?', Markup.inlineKeyboard([[Markup.button.callback('🔌 Відключити', AdminCallbacks.PlayerTelegramDisconnectConfirm)], [Markup.button.callback('❌ Скасувати', AdminCallbacks.PlayerTelegramConnection)]])); }
    private async disconnect(ctx: Context): Promise<void> { const connection = await this.connections.getConnection(this.clubId); if (!connection) return this.showRoot(ctx); if (!await this.canDisconnect(ctx.from!.id)) throw new Error('CONNECTION_PRIVACY_DENIED'); await this.connections.disconnect(connection.id, this.clubId); this.dialogs.delete(ctx.from!.id); await this.showRoot(ctx); }

    private async browseDialogs(ctx: Context, page: number, refresh: boolean): Promise<void> {
        const adminId = ctx.from!.id;
        const connection = await this.connections.getConnection(this.clubId);
        if (!connection || connection.telegramUserId !== adminId) throw new Error('CONNECTION_PRIVACY_DENIED');
        let selection = this.dialogs.get(adminId);
        if (refresh || !selection || selection.clubId !== this.clubId || Date.now() - selection.createdAt > 10 * 60_000) {
            const dialogs = await this.connections.listDialogs(connection, adminId);
            selection = { clubId: this.clubId, ownerId: adminId, createdAt: Date.now(), values: dialogs.map((dialog) => ({ token: randomBytes(4).toString('base64url'), dialog })) };
            this.dialogs.set(adminId, selection);
        }
        const size = 8; const pages = Math.max(1, Math.ceil(selection.values.length / size)); const current = Math.max(0, Math.min(page, pages - 1));
        const items = selection.values.slice(current * size, (current + 1) * size);
        await this.services.adminUi.show(ctx, `Оберіть групу · ${current + 1}/${pages}\n\nПоказано лише групи, доступні вашому Telegram-акаунту.`, Markup.inlineKeyboard([
            ...items.map((item) => [Markup.button.callback(item.dialog.title, `${AdminCallbacks.PlayerTelegramDialogPrefix}${item.token}`)]),
            [...(current > 0 ? [Markup.button.callback('⬅️', `${AdminCallbacks.PlayerTelegramDialogPagePrefix}${current - 1}`)] : []), ...(current + 1 < pages ? [Markup.button.callback('➡️', `${AdminCallbacks.PlayerTelegramDialogPagePrefix}${current + 1}`)] : [])],
            [Markup.button.callback('◀️ Назад', AdminCallbacks.PlayerTelegramImport)],
        ].filter((row) => row.length)));
    }

    private async selectDialog(ctx: Context, token: string): Promise<void> {
        const selection = this.dialogs.get(ctx.from!.id); const item = selection?.values.find((value) => value.token === token);
        if (!selection || selection.clubId !== this.clubId || selection.ownerId !== ctx.from!.id || !item) throw new Error('TELEGRAM_DIALOG_SELECTION_STALE');
        const connection = await this.connections.getConnection(this.clubId); if (!connection) throw new Error('TELEGRAM_CONNECTION_NOT_FOUND');
        await this.connections.addSource(this.clubId, connection, item.dialog, ctx.from!.id); this.dialogs.delete(ctx.from!.id); await this.showRoot(ctx);
    }

    private async scan(ctx: Context, shortId: string): Promise<void> {
        const source = await this.connections.getSourceByShortId(this.clubId, shortId); if (!source) throw new Error('TELEGRAM_IMPORT_SOURCE_UNAVAILABLE');
        await this.services.adminUi.show(ctx, `💬 ${source.title}\n\nОтримуємо учасників…`, Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', AdminCallbacks.PlayerTelegramImport)]]));
        const session = await this.imports.scan(source, ctx.from!.id);
        const warning = session.partial ? '\n\n⚠️ Telegram не надав повний список учасників цього чату.' : '';
        await this.services.adminUi.show(ctx, [`💬 ${source.title}`, '', `Учасників: ${session.candidates.length}`, '', `✅ Уже в клубі: ${session.existingCount}`, `➕ Нових: ${session.plan.newCount}`, `⚠️ Можливих дублів: ${session.possibleDuplicateCount}`, `✏️ Перевірити імʼя: ${session.reviewCount}`, `🤖 Пропущено: ${session.skippedCount}`, warning].join('\n'), Markup.inlineKeyboard([
            ...(session.plan.newCount ? [[Markup.button.callback('✅ Імпортувати готових', `${AdminCallbacks.PlayerTelegramImportConfirmPrefix}${session.id}`)]] : []),
            [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramImportCancelPrefix}${session.id}`)],
        ]));
    }

    private async commit(ctx: Context, id: string): Promise<void> { const result = await this.imports.commit(id, this.clubId, ctx.from!.id); const players = await this.services.repositories.players.list(); await this.services.adminUi.show(ctx, `✅ Імпорт завершено\n\nНових: ${result.created}\nОновлено: ${result.updated}\nБез змін: ${result.unchanged}`, createPlayersKeyboard(players.filter((player) => !player.isConfirmed && player.isActive).length)); }
    private async cancel(ctx: Context, id: string): Promise<void> { this.imports.cancel(id, this.clubId, ctx.from!.id); await this.showRoot(ctx); }
    private async canDisconnect(userId: number): Promise<boolean> { const settings = await this.services.repositories.settings.get(); return this.superAdminIds.includes(userId) || isClubOwner(settings.admins, userId) || (await this.connections.getConnection(this.clubId))?.telegramUserId === userId; }
    private async deleteSensitiveMessage(ctx: Context): Promise<void> { if (!ctx.message || !ctx.chat) return; await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined); }
    private async showError(ctx: Context, message: string): Promise<void> { await this.services.adminUi.show(ctx, `⚠️ ${message}`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', AdminCallbacks.PlayerTelegramImport)]])); }
    private logAuthFailure(telegramUserId: number, error: unknown): void { const original = safeTelegramErrorDetails(error); logger.error('telegram_qr_auth.failed', { clubId: this.clubId, requestedByTelegramUserId: telegramUserId, stage: error instanceof TelegramQrAuthError ? error.stage : this.services.adminFlow.getState(telegramUserId), reason: error instanceof TelegramQrAuthError ? error.reason : 'UNKNOWN', errorName: original.name, errorMessage: original.message, errorCode: original.code, rpcErrorMessage: original.errorMessage, stack: original.stack }); }
}

function backKeyboard() { return Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', AdminCallbacks.PlayerTelegramImport)]]); }
function qrCaption(): string { return '🔐 Підключення Telegram\n\n1. Відкрийте Telegram на телефоні.\n2. Відскануйте QR-код для входу.\n3. Підтвердьте підключення.\n\nQR діє обмежений час.'; }
function qrKeyboard(id: string) { return Markup.inlineKeyboard([[Markup.button.callback('🔄 Оновити QR', `${AdminCallbacks.PlayerTelegramQrRefreshPrefix}${id}`)], [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramQrCancelPrefix}${id}`)]]); }
function qrUserMessage(error: unknown): string { return error instanceof TelegramQrAuthError ? qrReasonMessage(error.reason) : 'Не вдалося підключити Telegram. Деталі записано в лог.'; }
function qrReasonMessage(reason: TelegramQrFailureReason): string { switch (reason) { case 'QR_TOKEN_EXPIRED': return 'QR-код більше неактуальний.'; case 'AUTH_ACCOUNT_MISMATCH': return 'Підключено інший Telegram-акаунт. Для безпеки підключіть акаунт, з якого ви зараз користуєтесь ботом.'; case 'PASSWORD_INVALID': return 'Невірний пароль двоетапної перевірки.'; case 'FLOOD_WAIT': return 'Telegram тимчасово обмежив спроби. Спробуйте пізніше.'; case 'NETWORK_ERROR': return 'Не вдалося звʼязатися з Telegram. Спробуйте ще раз.'; case 'SESSION_ENCRYPTION_FAILED': case 'SESSION_PERSIST_FAILED': return 'Telegram авторизовано, але не вдалося безпечно зберегти підключення.'; default: return 'Не вдалося підключити Telegram. Деталі записано в лог.'; } }
function friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'AUTHENTICATED_ACCOUNT_MISMATCH') return 'Підключений акаунт має належати адміністратору, який виконує підключення.';
    if (message === 'CONNECTION_PRIVACY_DENIED') return 'Лише власник підключеного акаунта може переглядати його чати.';
    if (message === 'TELEGRAM_USER_CONNECTION_NOT_CONFIGURED') return 'Імпорт з Telegram не налаштовано на сервері.';
    if (message.includes('AUTH_KEY')) return 'Підключення Telegram потребує повторної авторизації.';
    if (message.includes('FLOOD_WAIT')) return 'Telegram тимчасово обмежив запити. Спробуйте пізніше.';
    return 'Не вдалося виконати дію з Telegram. Спробуйте ще раз.';
}
