import { randomInt } from 'node:crypto';
import { Context, Markup } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { findNextUnresolvedCandidate, getImportUiState, safePlanSummary, TelegramPlayerImportService, TelegramPlayerImportSession } from '../../../domain/telegram-import/telegram-player-import.service';
import { TelegramUserConnectionManager } from '../../../domain/telegram-import/telegram-user-connection.manager';
import { TelegramQrAuthError, TelegramQrAuthService, TelegramQrFailureReason } from '../../../domain/telegram-import/telegram-qr-auth.service';
import { isClubOwner } from '../../../domain/settings/club-admin-authorization';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { AdminFlowState } from '../flows/admin-flow.types';
import { createPlayersKeyboard } from '../keyboards/player.keyboard';
import { logger } from '../../../utils/logger';
import { safeTelegramErrorDetails } from '../../../domain/telegram-import/telegram-auth-error';

type SourceSelection = { clubId: string; requestId: number; createdAt: number };

export class TelegramPlayerImportHandler {
    readonly messageStates: readonly AdminFlowState[] = ['waiting_telegram_qr_2fa_password', 'waiting_telegram_import_source', 'waiting_telegram_import_name'];
    private readonly sourceSelections = new Map<number, SourceSelection>();
    private readonly nameReviews = new Map<number, { sessionId: string; candidateToken: string }>();
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
            || callback.startsWith(AdminCallbacks.PlayerTelegramSourcePrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramImportConfirmPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramAmbiguousOpenPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramOverviewPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramSkipBlockedPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramAmbiguousMergePrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramAmbiguousCreatePrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramAmbiguousSkipPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramRenamePrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramImportCancelPrefix)
            || callback.startsWith(AdminCallbacks.PlayerTelegramImportCancelConfirmPrefix);
    }

    async handle(ctx: Context, callback: string): Promise<void> {
        if (!ctx.from) return;
        try {
            const reviewCallback = parseAmbiguousCallback(callback);
            if (reviewCallback) { logger.info('telegram_import.callback_received', { clubId: this.clubId, importSessionId: reviewCallback.sessionId, action: reviewCallback.action, candidateToken: reviewCallback.candidateToken }); return await this.resolveAmbiguous(ctx, reviewCallback); }
            if (callback.startsWith(AdminCallbacks.PlayerTelegramRenamePrefix)) { logger.info('telegram_import.callback_received', { clubId: this.clubId, action: 'rename' }); return await this.startRename(ctx, callback.slice(AdminCallbacks.PlayerTelegramRenamePrefix.length)); }
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
            if (callback === AdminCallbacks.PlayerTelegramAddSource) return await this.showSourcePicker(ctx);
            if (callback.startsWith(AdminCallbacks.PlayerTelegramSourcePrefix)) return await this.scan(ctx, callback.slice(AdminCallbacks.PlayerTelegramSourcePrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramImportConfirmPrefix)) return await this.commit(ctx, callback.slice(AdminCallbacks.PlayerTelegramImportConfirmPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramAmbiguousOpenPrefix)) return await this.openNextAmbiguous(ctx, callback.slice(AdminCallbacks.PlayerTelegramAmbiguousOpenPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramOverviewPrefix)) return await this.showImportOverview(ctx, callback.slice(AdminCallbacks.PlayerTelegramOverviewPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramSkipBlockedPrefix)) return await this.skipProblematic(ctx, callback.slice(AdminCallbacks.PlayerTelegramSkipBlockedPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramImportCancelConfirmPrefix)) return await this.cancel(ctx, callback.slice(AdminCallbacks.PlayerTelegramImportCancelConfirmPrefix.length));
            if (callback.startsWith(AdminCallbacks.PlayerTelegramImportCancelPrefix)) return await this.confirmImportCancel(ctx, callback.slice(AdminCallbacks.PlayerTelegramImportCancelPrefix.length));
        } catch (error) {
            const expected = importExpectedMessage(error);
            if (expected) { logger.info('telegram_import.callback_stale', { clubId: this.clubId, telegramUserId: ctx.from.id, reason: error instanceof Error ? error.message : String(error) }); await ctx.answerCbQuery(expected, { show_alert: true }).catch(() => undefined); return; }
            logger.error('telegram_import.ui_failed', { clubId: this.clubId, telegramUserId: ctx.from.id, error });
            await this.showError(ctx, friendlyError(error));
        }
    }

    canHandleMessage(adminId: number): boolean { return this.messageStates.includes(this.services.adminFlow.getState(adminId)); }

    async handleMessage(ctx: Context): Promise<boolean> {
        if (!ctx.from || !ctx.message || !this.canHandleMessage(ctx.from.id)) return false;
        const state = this.services.adminFlow.getState(ctx.from.id);
        if (state === 'waiting_telegram_import_source') return this.handleSourceMessage(ctx);
        if (state === 'waiting_telegram_import_name') return this.handleReviewName(ctx);
        if (!('text' in ctx.message)) { await this.services.adminUi.notice(ctx, 'Надішліть текстове значення.'); return true; }
        const value = ctx.message.text.trim(); await this.deleteSensitiveMessage(ctx);
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
        const activeState = this.services.adminFlow.getState(ctx.from!.id);
        if (activeState === 'waiting_telegram_qr_2fa_password') {
            const attempt = this.qrAttempts.get(ctx.from!.id); if (attempt) await this.qrAuth.cancel(attempt.id, this.clubId, ctx.from!.id, false).catch(() => undefined);
            this.qrAttempts.delete(ctx.from!.id);
            this.services.adminFlow.finish(ctx.from!.id);
        } else if (activeState === 'waiting_telegram_import_source') {
            this.sourceSelections.delete(ctx.from!.id);
            this.services.adminFlow.finish(ctx.from!.id);
        } else if (activeState === 'waiting_telegram_import_name') {
            this.nameReviews.delete(ctx.from!.id);
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
        await this.services.adminUi.show(ctx, ['💬 Імпорт з Telegram', '', ...(sources.length ? ['Збережені чати:', ...sources.map((source) => `• ${source.title}`)] : ['Чатів для імпорту ще немає.']), connection.status === 'reauth_required' ? '\n⚠️ Підключення потребує повторної авторизації.' : ''].filter(Boolean).join('\n'), Markup.inlineKeyboard([
            ...sources.map((source) => [Markup.button.callback(source.title, `${AdminCallbacks.PlayerTelegramSourcePrefix}${source.shortId}`)]),
            ...(owner ? [[Markup.button.callback('➕ Обрати інший чат', AdminCallbacks.PlayerTelegramAddSource)]] : []),
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

    private async showSourcePicker(ctx: Context): Promise<void> {
        const adminId = ctx.from!.id; const connection = await this.connections.getConnection(this.clubId);
        if (!connection || connection.telegramUserId !== adminId) throw new Error('CONNECTION_PRIVACY_DENIED');
        const requestId = randomInt(1, 2_147_483_647);
        this.sourceSelections.set(adminId, { clubId: this.clubId, requestId, createdAt: Date.now() });
        this.services.adminFlow.start(adminId, 'waiting_telegram_import_source');
        if (ctx.callbackQuery) await ctx.deleteMessage().catch(() => undefined);
        const message = await ctx.reply('💬 Оберіть групу\n\nНатисніть кнопку нижче та виберіть потрібний чат.\n\nТакож можна переслати повідомлення з групи або надіслати посилання t.me.', createTelegramSourcePickerKeyboard(requestId));
        this.services.adminUi.trackBotMessage(adminId, ctx.chat!.id, message.message_id);
    }

    private async handleSourceMessage(ctx: Context): Promise<boolean> {
        const message = ctx.message;
        if (!message) return false;
        const adminId = ctx.from!.id; const selection = this.sourceSelections.get(adminId);
        if (!selection || selection.clubId !== this.clubId || Date.now() - selection.createdAt > 10 * 60_000) {
            this.sourceSelections.delete(adminId); this.services.adminFlow.finish(adminId);
            await this.removeSourceKeyboard(ctx, '⚠️ Вибір чату вже неактуальний. Відкрийте його знову.'); return true;
        }
        try {
            const shared = extractTelegramSourceSelector(message, selection.requestId);
            if (shared.kind === 'selected') { await this.acceptSource(ctx, shared.selector); return true; }
            if (shared.kind === 'wrong_request') { await ctx.reply('⚠️ Цей вибір групи належить іншому запиту. Натисніть «Обрати групу» ще раз.'); return true; }
            if (shared.kind === 'hidden_forward') { await ctx.reply('Не вдалося визначити групу з пересланого повідомлення. Скористайтеся кнопкою «💬 Обрати групу».'); return true; }
            if ('text' in message) {
                const text = message.text.trim();
                if (text === '❌ Скасувати') { this.sourceSelections.delete(adminId); this.services.adminFlow.finish(adminId); await this.removeSourceKeyboard(ctx, 'Вибір чату скасовано.'); await this.showRoot(ctx); return true; }
                if (text === '↪️ Переслати повідомлення') { await ctx.reply('Перешліть сюди будь-яке повідомлення з потрібної групи.'); return true; }
                if (text === '🔗 Надіслати посилання') { await ctx.reply('Надішліть посилання на групу або повідомлення у форматі t.me/…'); return true; }
                const selector = parseTelegramChatLink(text); if (selector) { await this.acceptSource(ctx, selector); return true; }
                await ctx.reply('Надішліть посилання t.me/…, перешліть повідомлення або скористайтеся кнопкою «💬 Обрати групу».'); return true;
            }
            await ctx.reply('Не вдалося визначити групу. Скористайтеся кнопкою «💬 Обрати групу».');
        } catch (error) {
            if (error instanceof Error && error.message === 'TELEGRAM_SELECTED_GROUP_INACCESSIBLE') await ctx.reply('⚠️ Підключений Telegram-акаунт не має доступу до цієї групи. Оберіть іншу групу.');
            else throw error;
        }
        return true;
    }

    private async acceptSource(ctx: Context, selector: { chatId?: string; username?: string }): Promise<void> {
        const connection = await this.connections.getConnection(this.clubId); if (!connection) throw new Error('TELEGRAM_CONNECTION_NOT_FOUND');
        const group = await this.connections.resolveAccessibleGroup(connection, ctx.from!.id, selector);
        await this.connections.addSource(this.clubId, connection, group, ctx.from!.id);
        this.sourceSelections.delete(ctx.from!.id); this.services.adminFlow.finish(ctx.from!.id);
        await this.removeSourceKeyboard(ctx, `✅ Додано чат «${group.title}».`); await this.showRoot(ctx);
    }

    private async removeSourceKeyboard(ctx: Context, text: string): Promise<void> { await ctx.reply(text, Markup.removeKeyboard()); }

    private async validate(ctx: Context): Promise<void> { const connection = await this.connections.getConnection(this.clubId); if (!connection) return this.showRoot(ctx); await this.connections.validate(connection.id); await this.showConnection(ctx); }
    private async confirmDisconnect(ctx: Context): Promise<void> { if (!await this.canDisconnect(ctx.from!.id)) throw new Error('CONNECTION_PRIVACY_DENIED'); await this.services.adminUi.show(ctx, '🔌 Відключити Telegram від клубу?', Markup.inlineKeyboard([[Markup.button.callback('🔌 Відключити', AdminCallbacks.PlayerTelegramDisconnectConfirm)], [Markup.button.callback('❌ Скасувати', AdminCallbacks.PlayerTelegramConnection)]])); }
    private async disconnect(ctx: Context): Promise<void> { const connection = await this.connections.getConnection(this.clubId); if (!connection) return this.showRoot(ctx); if (!await this.canDisconnect(ctx.from!.id)) throw new Error('CONNECTION_PRIVACY_DENIED'); await this.connections.disconnect(connection.id, this.clubId); this.sourceSelections.delete(ctx.from!.id); await this.showRoot(ctx); }

    private async scan(ctx: Context, shortId: string): Promise<void> {
        const source = await this.connections.getSourceByShortId(this.clubId, shortId); if (!source) throw new Error('TELEGRAM_IMPORT_SOURCE_UNAVAILABLE');
        await this.services.adminUi.show(ctx, `💬 ${source.title}\n\nОтримуємо учасників…`, Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', AdminCallbacks.PlayerTelegramImport)]]));
        const session = await this.imports.scan(source, ctx.from!.id);
        await this.renderPreview(ctx, session, source.title);
    }

    private async renderPreview(ctx: Context, session: TelegramPlayerImportSession, title = 'Telegram'): Promise<void> {
        const warning = session.partial ? '\n⚠️ Telegram не надав повний список учасників цього чату.' : '';
        const ambiguousCount = session.plan.conflicts.filter((conflict) => conflict.type === 'ambiguous_exact_match').length;
        const blocked = session.blockedCount ? `\n⚠️ Потребують перевірки: ${session.blockedCount}` : '';
        const hasWork = session.plan.newCount + session.plan.updateCount > 0;
        const ui = getImportUiState(session); const nextReview = findNextUnresolvedCandidate(session);
        if (session.state === 'reviewing' && session.blockedCount > 0 && nextReview && !ui.availableActions.includes('review')) { logger.error('telegram_import.ui_invariant_failed', { clubId: this.clubId, importSessionId: session.id, lifecycle: session.state, availableActions: ui.availableActions, nextReviewCandidateType: nextReview.type, ...safePlanSummary(session) }); throw new Error('TELEGRAM_IMPORT_UI_INVARIANT'); }
        await this.services.adminUi.show(ctx, [`💬 ${title}`, '', `Учасників Telegram: ${session.candidates.length}`, '', `➕ Нових: ${session.plan.newCount}`, `✅ Уже є: ${session.existingCount + session.plan.unchangedCount}`, `🔄 Оновлень: ${session.plan.updateCount}`, `⏭ Пропущено: ${session.skippedCount}`, `⚠️ На перевірці: ${session.blockedCount}`, `❌ Помилок: ${session.plan.errorCount}`, ambiguousCount ? `⚠️ Неоднозначні збіги: ${ambiguousCount}` : '', blocked, session.canCommit && hasWork ? '\n✅ Готово до імпорту' : session.canCommit ? '\n✅ Усі учасники вже є у списку гравців.' : '', warning].filter(Boolean).join('\n'), createTelegramImportPreviewKeyboard(session, ambiguousCount));
        logger.info('telegram_import.preview_rendered', { clubId: this.clubId, importSessionId: session.id, lifecycle: session.state, availableActions: ui.availableActions, nextReviewCandidateType: nextReview?.type, nextReviewCandidateToken: nextReview?.candidateToken, ...safePlanSummary(session) });
    }
    private async showImportOverview(ctx: Context, id: string): Promise<void> { this.nameReviews.delete(ctx.from!.id); this.services.adminFlow.finish(ctx.from!.id); await this.renderPreview(ctx, this.imports.get(id, this.clubId, ctx.from!.id)); }
    private async openNextAmbiguous(ctx: Context, id: string): Promise<void> {
        const session = this.imports.get(id, this.clubId, ctx.from!.id);
        const review = await this.imports.getNextReview(id, this.clubId, ctx.from!.id);
        if (review) { logger.info('telegram_import.review_opened', { clubId: this.clubId, importSessionId: id, candidateToken: review.candidateToken, type: review.type, remainingBlockedCount: review.remaining }); await this.renderReviewCandidate(ctx, id, review); return; }
        await this.services.adminUi.show(ctx, '⚠️ Ці конфлікти не можна вирішити автоматично. Скасуйте імпорт, виправте дані та почніть знову.', Markup.inlineKeyboard([[Markup.button.callback('◀️ До огляду', `${AdminCallbacks.PlayerTelegramOverviewPrefix}${id}`)], [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramImportCancelPrefix}${id}`)]]));
    }
    private async renderReviewCandidate(ctx: Context, sessionId: string, review: NonNullable<Awaited<ReturnType<TelegramPlayerImportService['getNextReview']>>>): Promise<void> {
        const heading = review.type === 'AMBIGUOUS_MATCH' ? '⚠️ Неоднозначний збіг' : review.type === 'POSSIBLE_DUPLICATE' ? '⚠️ Можливий дубль' : '✏️ Перевірте гравця';
        const matches = review.players.length ? ['', review.type === 'AMBIGUOUS_MATCH' ? 'Можливі гравці:' : 'Схожий гравець:', ...review.players.map((player, index) => `${index + 1}. ${player.displayName}`)] : [];
        await this.services.adminUi.show(ctx, [heading, '', `Залишилось перевірити: ${review.remaining}`, '', 'Telegram:', review.telegramUsername ? `@${review.telegramUsername}` : review.telegramDisplayName, ...matches].join('\n'), createReviewCandidateKeyboard(sessionId, review));
    }
    private async resolveAmbiguous(ctx: Context, callback: AmbiguousCallback): Promise<void> {
        let decision;
        if (callback.action === 'merge') { const existingPlayerId = this.imports.resolvePlayerToken(callback.sessionId, this.clubId, ctx.from!.id, callback.candidateToken, callback.playerToken!); decision = { type: 'merge_existing' as const, existingPlayerId }; }
        else decision = callback.action === 'create' ? { type: 'create_new' as const } : { type: 'skip' as const };
        const session = await this.imports.resolveReview(callback.sessionId, this.clubId, ctx.from!.id, callback.candidateToken, decision);
        const next = await this.imports.getNextReview(callback.sessionId, this.clubId, ctx.from!.id); if (next) await this.renderReviewCandidate(ctx, callback.sessionId, next); else await this.renderPreview(ctx, session);
    }
    private async startRename(ctx: Context, payload: string): Promise<void> { const [sessionId, candidateToken] = payload.split(':'); if (!sessionId || !candidateToken) throw new Error('STALE_CALLBACK'); this.imports.get(sessionId, this.clubId, ctx.from!.id); this.nameReviews.set(ctx.from!.id, { sessionId, candidateToken }); this.services.adminFlow.start(ctx.from!.id, 'waiting_telegram_import_name'); await this.services.adminUi.show(ctx, '✏️ Вкажіть імʼя гравця.', Markup.inlineKeyboard([[Markup.button.callback('◀️ До огляду', `${AdminCallbacks.PlayerTelegramOverviewPrefix}${sessionId}`)]])); }
    private async handleReviewName(ctx: Context): Promise<boolean> { if (!ctx.from || !ctx.message || !('text' in ctx.message)) return true; const pending = this.nameReviews.get(ctx.from.id); if (!pending) throw new Error('STALE_CALLBACK'); const displayName = ctx.message.text.trim().replace(/\s+/g, ' '); if (!/\p{L}/u.test(displayName)) { await ctx.reply('Вкажіть імʼя, що містить літери.'); return true; } this.nameReviews.delete(ctx.from.id); this.services.adminFlow.finish(ctx.from.id); const session = await this.imports.resolveReview(pending.sessionId, this.clubId, ctx.from.id, pending.candidateToken, { type: 'rename_and_create', displayName }); const next = await this.imports.getNextReview(pending.sessionId, this.clubId, ctx.from.id); if (next) await this.renderReviewCandidate(ctx, pending.sessionId, next); else await this.renderPreview(ctx, session); return true; }
    private async skipProblematic(ctx: Context, id: string): Promise<void> { logger.info('telegram_import.callback_received', { clubId: this.clubId, importSessionId: id, action: 'skip_problematic' }); await this.renderPreview(ctx, await this.imports.skipProblematic(id, this.clubId, ctx.from!.id)); }
    private async commit(ctx: Context, id: string): Promise<void> {
        const session = this.imports.get(id, this.clubId, ctx.from!.id);
        if (!session.canCommit) { logger.warn('telegram_import.commit_blocked', { clubId: this.clubId, importSessionId: id, ...safePlanSummary(session) }); await this.renderPreview(ctx, session); return; }
        logger.info('telegram_import.commit_started', { clubId: this.clubId, importSessionId: id });
        try { const result = await this.imports.commit(id, this.clubId, ctx.from!.id); const players = await this.services.repositories.players.list(); await this.services.adminUi.show(ctx, `✅ Імпорт завершено\n\nНових: ${result.created}\nОновлено: ${result.updated}\nБез змін: ${result.unchanged}`, createPlayersKeyboard(players.filter((player) => !player.isConfirmed && player.isActive).length)); }
        catch (error) { if (error instanceof Error && ['IMPORT_PLAN_BLOCKED', 'IMPORT_PLAN_STALE'].includes(error.message)) { const current = this.imports.get(id, this.clubId, ctx.from!.id); logger.warn('telegram_import.commit_blocked', { clubId: this.clubId, importSessionId: id, reason: error.message, ...safePlanSummary(current) }); await this.renderPreview(ctx, current); return; } throw error; }
    }
    private async confirmImportCancel(ctx: Context, id: string): Promise<void> { const session = this.imports.get(id, this.clubId, ctx.from!.id); const meaningful = Object.keys(session.decisions).length > 0; if (!meaningful) return this.cancel(ctx, id); await this.services.adminUi.show(ctx, '❌ Скасувати імпорт?\n\nЗроблені рішення буде втрачено.', Markup.inlineKeyboard([[Markup.button.callback('Так, скасувати', `${AdminCallbacks.PlayerTelegramImportCancelConfirmPrefix}${id}`)], [Markup.button.callback('◀️ Продовжити', `${AdminCallbacks.PlayerTelegramOverviewPrefix}${id}`)]])); }
    private async cancel(ctx: Context, id: string): Promise<void> { this.nameReviews.delete(ctx.from!.id); this.services.adminFlow.finish(ctx.from!.id); this.imports.cancel(id, this.clubId, ctx.from!.id); await this.showRoot(ctx); }
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
function importExpectedMessage(error: unknown): string | undefined { const message = error instanceof Error ? error.message : ''; if (['TELEGRAM_IMPORT_SESSION_STALE', 'IMPORT_SESSION_EXPIRED', 'STALE_CALLBACK', 'TELEGRAM_IMPORT_REVIEW_STALE', 'CANDIDATE_ALREADY_RESOLVED'].includes(message)) return message === 'IMPORT_SESSION_EXPIRED' ? '⌛ Цей імпорт уже неактуальний.' : 'Цей імпорт уже неактуальний.'; if (message === 'IMPORT_ALREADY_COMPLETED') return '✅ Цей імпорт уже завершено.'; if (message === 'IMPORT_ALREADY_COMMITTING') return '⏳ Імпорт уже виконується.'; return undefined; }

export type AmbiguousCallback = { action: 'merge' | 'create' | 'skip'; sessionId: string; candidateToken: string; playerToken?: string };
export function parseAmbiguousCallback(callback: string): AmbiguousCallback | undefined {
    const definitions = [
        [AdminCallbacks.PlayerTelegramAmbiguousMergePrefix, 'merge'],
        [AdminCallbacks.PlayerTelegramAmbiguousCreatePrefix, 'create'],
        [AdminCallbacks.PlayerTelegramAmbiguousSkipPrefix, 'skip'],
    ] as const;
    for (const [prefix, action] of definitions) if (callback.startsWith(prefix)) {
        const [sessionId, candidateToken, playerToken] = callback.slice(prefix.length).split(':');
        if (sessionId && candidateToken && (action !== 'merge' || playerToken)) return { action, sessionId, candidateToken, playerToken };
    }
    return undefined;
}

export function createAmbiguousReviewKeyboard(sessionId: string, review: NonNullable<Awaited<ReturnType<TelegramPlayerImportService['getNextAmbiguous']>>>) {
    return Markup.inlineKeyboard([
        ...review.players.map((player, index) => [Markup.button.callback(`${index + 1}. ${player.displayName}`, `${AdminCallbacks.PlayerTelegramAmbiguousMergePrefix}${sessionId}:${review.candidateToken}:${player.token}`)]),
        [Markup.button.callback('➕ Створити нового', `${AdminCallbacks.PlayerTelegramAmbiguousCreatePrefix}${sessionId}:${review.candidateToken}`)],
        [Markup.button.callback('⏭ Пропустити', `${AdminCallbacks.PlayerTelegramAmbiguousSkipPrefix}${sessionId}:${review.candidateToken}`)],
        [Markup.button.callback('◀️ До огляду', `${AdminCallbacks.PlayerTelegramOverviewPrefix}${sessionId}`)],
    ]);
}

export function createReviewCandidateKeyboard(sessionId: string, review: NonNullable<Awaited<ReturnType<TelegramPlayerImportService['getNextReview']>>>) {
    return Markup.inlineKeyboard([
        ...review.players.map((player, index) => [Markup.button.callback(`${index + 1}. ${player.displayName}`, `${AdminCallbacks.PlayerTelegramAmbiguousMergePrefix}${sessionId}:${review.candidateToken}:${player.token}`)]),
        ...(review.type === 'NEEDS_REVIEW' ? [[Markup.button.callback('✏️ Вказати імʼя', `${AdminCallbacks.PlayerTelegramRenamePrefix}${sessionId}:${review.candidateToken}`)]] : []),
        [Markup.button.callback(review.type === 'NEEDS_REVIEW' ? '➕ Створити як є' : '➕ Створити нового', `${AdminCallbacks.PlayerTelegramAmbiguousCreatePrefix}${sessionId}:${review.candidateToken}`)],
        [Markup.button.callback('⏭ Пропустити', `${AdminCallbacks.PlayerTelegramAmbiguousSkipPrefix}${sessionId}:${review.candidateToken}`)],
        [Markup.button.callback('◀️ До огляду', `${AdminCallbacks.PlayerTelegramOverviewPrefix}${sessionId}`)],
    ]);
}

export function createTelegramImportPreviewKeyboard(session: TelegramPlayerImportSession, ambiguousCount: number) {
    const ui = getImportUiState(session);
    return Markup.inlineKeyboard([
        ...(ui.availableActions.includes('commit') ? [[Markup.button.callback('✅ Імпортувати', `${AdminCallbacks.PlayerTelegramImportConfirmPrefix}${session.id}`)]] : []),
        ...(ui.availableActions.includes('review') ? [[Markup.button.callback(ambiguousCount ? `⚠️ Перевірити збіги (${ambiguousCount})` : '⚠️ Перевірити', `${AdminCallbacks.PlayerTelegramAmbiguousOpenPrefix}${session.id}`)]] : []),
        ...(ui.availableActions.includes('skip_problematic') ? [[Markup.button.callback('⏭ Пропустити проблемні', `${AdminCallbacks.PlayerTelegramSkipBlockedPrefix}${session.id}`)]] : []),
        [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.PlayerTelegramImportCancelPrefix}${session.id}`)],
    ]);
}

export function parseTelegramChatLink(value: string): { chatId?: string; username?: string } | undefined {
    let url: URL; try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch { return undefined; }
    if (!['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me'].includes(url.hostname.toLocaleLowerCase())) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length || parts[0] === 'joinchat' || parts[0].startsWith('+')) return undefined;
    if (parts[0] === 'c' && /^\d+$/.test(parts[1] ?? '')) return { chatId: `-100${parts[1]}` };
    return /^[A-Za-z0-9_]{4,}$/.test(parts[0]) ? { username: parts[0] } : undefined;
}

export function createTelegramSourcePickerKeyboard(requestId: number) {
    return Markup.keyboard([
        [Markup.button.groupRequest('💬 Обрати групу', requestId)],
        [Markup.button.text('↪️ Переслати повідомлення'), Markup.button.text('🔗 Надіслати посилання')],
        [Markup.button.text('❌ Скасувати')],
    ]).resize().oneTime();
}

export type TelegramSourceSelectionResult =
    | { kind: 'selected'; selector: { chatId: string } }
    | { kind: 'wrong_request' }
    | { kind: 'hidden_forward' }
    | { kind: 'none' };

export function extractTelegramSourceSelector(message: object, expectedRequestId: number): TelegramSourceSelectionResult {
    if ('chat_shared' in message) {
        const shared = message.chat_shared as { request_id?: unknown; chat_id?: unknown };
        if (shared.request_id !== expectedRequestId) return { kind: 'wrong_request' };
        if (typeof shared.chat_id === 'number' || typeof shared.chat_id === 'string') return { kind: 'selected', selector: { chatId: String(shared.chat_id) } };
        return { kind: 'none' };
    }
    if ('forward_origin' in message && message.forward_origin) {
        const origin = message.forward_origin as { type?: string; sender_chat?: { id?: unknown }; chat?: { id?: unknown } };
        const id = origin.type === 'chat' ? origin.sender_chat?.id : origin.type === 'channel' ? origin.chat?.id : undefined;
        if (typeof id === 'number' || typeof id === 'string') return { kind: 'selected', selector: { chatId: String(id) } };
        return { kind: 'hidden_forward' };
    }
    return { kind: 'none' };
}
