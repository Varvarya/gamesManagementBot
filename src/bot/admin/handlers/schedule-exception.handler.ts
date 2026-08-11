import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { AdminFlowState } from '../flows/admin-flow.types';
import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import { createExceptionActionsKeyboard, createExceptionCardKeyboard, createExceptionChatsKeyboard, createExceptionConfirmKeyboard, createExceptionDeleteKeyboard, createExceptionsKeyboard, createOccurrenceSelectionKeyboard } from '../keyboards/schedule-exception.keyboard';
import { SaveScheduleExceptionInput, ScheduleException } from '../../../domain/schedule-exceptions/schedule-exception.types';
import { addCalendarDays, getZonedNow } from '../../../domain/templates/template-scheduler.service';
import { formatDay } from '../ui/admin-formatters';
import { ScheduleExceptionReconciliationService } from '../../../domain/schedule-exceptions/schedule-exception-reconciliation.service';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { TrainingCancellationScheduler } from '../../../scheduler/training-cancellation.scheduler';

export class ScheduleExceptionHandler {
    readonly textStates: readonly AdminFlowState[] = ['waiting_exception_date', 'waiting_exception_value', 'waiting_exception_extra'];
    constructor(private readonly services: ServicesContext, private readonly reconciliation?: ScheduleExceptionReconciliationService, private readonly scheduler?: TemplateSchedulerService, private readonly cancellationScheduler?: TrainingCancellationScheduler) {}
    canHandle(callback: string): boolean {
        return [AdminCallbacks.ScheduleExceptions, AdminCallbacks.ScheduleExceptionAdd, AdminCallbacks.ScheduleExceptionHistory,
            AdminCallbacks.ScheduleExceptionExtra, AdminCallbacks.ScheduleExceptionConfirm, AdminCallbacks.ScheduleExceptionDelete,
            AdminCallbacks.ScheduleExceptionDeleteConfirm, AdminCallbacks.ScheduleExceptionRevertConfirm, AdminCallbacks.ScheduleUpcoming].includes(callback as never)
            || [AdminCallbacks.ScheduleExceptionEntryPrefix, AdminCallbacks.ScheduleExceptionViewPrefix, AdminCallbacks.ScheduleExceptionActionPrefix, AdminCallbacks.ScheduleExceptionChatPrefix].some((prefix) => callback.startsWith(prefix));
    }
    canHandleText(adminId: number): boolean { return this.textStates.includes(this.services.adminFlow.getState(adminId)); }

    async handle(ctx: Context, callback: string): Promise<void> {
        const adminId = ctx.from?.id; if (!adminId) return;
        if (callback === AdminCallbacks.ScheduleExceptions) { this.services.adminFlow.finish(adminId); await this.showList(ctx); return; }
        if (callback === AdminCallbacks.ScheduleExceptionHistory) { await this.showList(ctx, true); return; }
        if (callback === AdminCallbacks.ScheduleExceptionAdd) {
            this.services.adminFlow.start(adminId, 'waiting_exception_date');
            await this.services.adminUi.show(ctx, '📌 Новий виняток\n\nОберіть дату.\n\nФормат: 2026-08-18 або 18.08', createFlowCancelKeyboard(AdminCallbacks.ScheduleExceptions)); return;
        }
        if (callback === AdminCallbacks.ScheduleExceptionExtra) { await this.startExtra(ctx, adminId); return; }
        if (callback.startsWith(AdminCallbacks.ScheduleExceptionEntryPrefix)) {
            const entryId = callback.slice(AdminCallbacks.ScheduleExceptionEntryPrefix.length);
            this.services.adminFlow.setData(adminId, { exceptionEntryId: entryId, exceptionId: (await this.services.scheduleExceptions.findForOccurrence(entryId, this.services.adminFlow.getData(adminId).exceptionDate!))?.id });
            await this.showActions(ctx); return;
        }
        if (callback.startsWith(AdminCallbacks.ScheduleExceptionViewPrefix)) { await this.showException(ctx, adminId, callback.slice(AdminCallbacks.ScheduleExceptionViewPrefix.length)); return; }
        if (callback.startsWith(AdminCallbacks.ScheduleExceptionActionPrefix)) { await this.startAction(ctx, adminId, callback.slice(AdminCallbacks.ScheduleExceptionActionPrefix.length)); return; }
        if (callback.startsWith(AdminCallbacks.ScheduleExceptionChatPrefix)) { await this.chooseChat(ctx, adminId, Number(callback.slice(AdminCallbacks.ScheduleExceptionChatPrefix.length))); return; }
        if (callback === AdminCallbacks.ScheduleExceptionConfirm) { await this.confirm(ctx, adminId); return; }
        if (callback === AdminCallbacks.ScheduleExceptionDelete) { await this.confirmDelete(ctx, adminId); return; }
        if (callback === AdminCallbacks.ScheduleExceptionDeleteConfirm) { const id = this.services.adminFlow.getData(adminId).exceptionId; if (id) await this.services.scheduleExceptions.delete(id); this.services.adminFlow.finish(adminId); await this.showList(ctx); return; }
        if (callback === AdminCallbacks.ScheduleExceptionRevertConfirm) { await this.revertPublished(ctx, adminId); return; }
        if (callback === AdminCallbacks.ScheduleUpcoming) await this.showUpcoming(ctx);
    }

    async handleText(ctx: Context, text: string): Promise<void> {
        const adminId = ctx.from?.id; if (!adminId) return;
        try {
            const state = this.services.adminFlow.getState(adminId);
            if (state === 'waiting_exception_date') { const date = await this.parseDate(text); this.services.adminFlow.setData(adminId, { exceptionDate: date }); if (this.services.adminFlow.getData(adminId).exceptionAction === 'extra') await this.startExtra(ctx, adminId); else await this.selectOccurrence(ctx, date); return; }
            if (state === 'waiting_exception_extra') { await this.parseExtra(ctx, adminId, text); return; }
            await this.parseOverride(ctx, adminId, text);
        } catch (error) { await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося прочитати дані.', createFlowCancelKeyboard(AdminCallbacks.ScheduleExceptions)); }
    }

    private async showList(ctx: Context, history = false): Promise<void> {
        const today = await this.today(); const items = history ? await this.services.scheduleExceptions.listHistory(today) : await this.services.scheduleExceptions.listUpcoming(today);
        await this.services.adminUi.show(ctx, ['📌 Винятки', '', items.length ? items.map((item) => `${displayDate(item.date)} · ${item.title ?? 'Розклад'}\n${item.type === 'cancel' ? '❌ Скасовано' : item.type === 'extra' ? '➕ Додаткове' : '📌 Змінено'}`).join('\n\n') : 'Винятків поки немає.'].join('\n'), createExceptionsKeyboard(items, history));
    }
    private async selectOccurrence(ctx: Context, date: string): Promise<void> {
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
        const templates = (await this.services.repositories.templates.list()).filter((item) => item.enabled);
        const slots = templates.flatMap((template) => template.slots.filter((slot) => slot.enabled && slot.dayOfWeek === weekday).map((slot) => ({ slot, title: template.title })));
        if (!slots.length) { await this.services.adminUi.show(ctx, 'На цю дату немає тренувань у розкладі.\n\nМожна додати окреме тренування.', createOccurrenceSelectionKeyboard([])); return; }
        if (slots.length === 1) { this.services.adminFlow.setData(ctx.from!.id, { exceptionEntryId: slots[0].slot.id, exceptionId: (await this.services.scheduleExceptions.findForOccurrence(slots[0].slot.id, date))?.id }); await this.showActions(ctx); return; }
        await this.services.adminUi.show(ctx, `📅 ${displayDate(date)}\n\nОберіть тренування.`, createOccurrenceSelectionKeyboard(slots));
    }
    private async showActions(ctx: Context): Promise<void> {
        const data = this.services.adminFlow.getData(ctx.from!.id); const base = await this.base(data.exceptionEntryId!);
        await this.services.adminUi.show(ctx, [`📌 ${displayDate(data.exceptionDate!)}`, '', `${base.slot.startTime}–${base.slot.endTime} · ${base.template.title}`, '', 'Що змінити?'].join('\n'), createExceptionActionsKeyboard());
    }
    private async startAction(ctx: Context, adminId: number, action: string): Promise<void> {
        const data = this.services.adminFlow.getData(adminId);
        if (action === 'edit') { const item = data.exceptionId ? await this.services.scheduleExceptions.findById(data.exceptionId) : undefined; if (!item) return; this.services.adminFlow.setData(adminId, { exceptionDate: item.date, exceptionEntryId: item.scheduleEntryId, pendingException: item }); if (item.type === 'extra') { await this.startExtra(ctx, adminId); return; } await this.showActions(ctx); return; }
        if (!['cancel', 'time', 'places', 'minimum', 'chat', 'publication', 'publication_now', 'publication_manual', 'multiple'].includes(action)) return;
        this.services.adminFlow.setData(adminId, { exceptionAction: action as never });
        if (action === 'cancel') { await this.prepare(ctx, adminId, { type: 'cancel' }); return; }
        if (action === 'publication_now') { await this.prepare(ctx, adminId, { type: 'override', publicationEnabled: true, publishDaysBefore: 0 }); return; }
        if (action === 'publication_manual') { await this.prepare(ctx, adminId, { type: 'override', publicationEnabled: false }); return; }
        if (action === 'chat') { const chats = await this.services.chats.getEnabled(); if (!chats.length) { await this.services.adminUi.replaceWithError(ctx, 'Спочатку додайте активний чат.', createFlowCancelKeyboard(AdminCallbacks.Chats)); return; } await this.services.adminUi.show(ctx, '💬 Оберіть чат для цієї дати.', createExceptionChatsKeyboard(chats)); return; }
        this.services.adminFlow.transition(adminId, 'waiting_exception_value');
        const prompt = action === 'time' ? 'Надішліть новий час:\n19:00-21:00' : action === 'places' ? 'Надішліть нову кількість місць.' : action === 'minimum' ? 'Надішліть новий мінімум гравців.' : action === 'publication' ? 'Надішліть новий час публікації, наприклад 12:00.' : 'Надішліть потрібні зміни окремими рядками:\nЧас: 19:00-21:00\nМісця: 16\nМінімум: 6\nПублікація: 12:00';
        await this.services.adminUi.show(ctx, prompt, createFlowCancelKeyboard(AdminCallbacks.ScheduleExceptions));
    }
    private async parseOverride(ctx: Context, adminId: number, text: string): Promise<void> {
        const action = this.services.adminFlow.getData(adminId).exceptionAction; const changes: Partial<ScheduleException> = {};
        if (action === 'time') { const range = parseRange(text); changes.startTime = range[0]; changes.endTime = range[1]; }
        else if (action === 'places') changes.placesLimit = positive(text);
        else if (action === 'minimum') changes.minPlayers = nonNegative(text);
        else if (action === 'publication') changes.publishTime = validTime(text);
        else if (action === 'multiple') Object.assign(changes, parseMultiple(text));
        await this.prepare(ctx, adminId, { type: 'override', ...changes });
    }
    private async chooseChat(ctx: Context, adminId: number, chatId: number): Promise<void> {
        await this.services.chats.getRequired(chatId); const data = this.services.adminFlow.getData(adminId);
        if (data.exceptionAction === 'extra') { const pending = data.pendingException as Partial<ScheduleException>; await this.prepare(ctx, adminId, { ...pending, type: 'extra', chatIds: [chatId] }); }
        else await this.prepare(ctx, adminId, { type: 'override', chatIds: [chatId] });
    }
    private async prepare(ctx: Context, adminId: number, changes: Partial<ScheduleException>): Promise<void> {
        const data = this.services.adminFlow.getData(adminId); const previous = data.exceptionId ? await this.services.scheduleExceptions.findById(data.exceptionId) : undefined;
        const pending = { ...previous, clubId: this.services.repositories.clubId, scheduleEntryId: data.exceptionEntryId, date: data.exceptionDate!, createdByTelegramUserId: previous?.createdByTelegramUserId ?? adminId, ...changes };
        if (pending.type === 'override' && data.exceptionEntryId) { const base = await this.base(data.exceptionEntryId); const places = pending.placesLimit ?? base.template.placesLimit; const min = pending.minPlayers ?? base.template.minPlayers; if (min > places) throw new Error('Не можна встановити мінімум більший за кількість місць.'); }
        this.services.adminFlow.transition(adminId, 'waiting_exception_value', { pendingException: pending });
        const live = data.exceptionEntryId && data.exceptionDate ? await this.services.repositories.trainings.findAnyByTemplateSlotAndDate(data.exceptionEntryId, data.exceptionDate) : undefined;
        const occupied = live?.participants.reduce((sum, entry) => sum + entry.places, 0) ?? 0;
        const capacityWarning = pending.placesLimit !== undefined && occupied > pending.placesLimit ? `\n\n⚠️ Уже записано ${occupied} місць. Поточних гравців не буде видалено; нові записи зупиняться до звільнення місць.` : '';
        await this.services.adminUi.show(ctx, `${renderPreview(pending)}${capacityWarning}`, createExceptionConfirmKeyboard());
    }
    private async confirm(ctx: Context, adminId: number): Promise<void> {
        const pending = this.services.adminFlow.getData(adminId).pendingException as SaveScheduleExceptionInput | undefined; if (!pending) return;
        const saved = await this.services.scheduleExceptions.save(pending); if (this.services.adminFlow.getData(adminId).exceptionAction === 'publication_now') await this.scheduler?.publishExceptionNow(saved.id); this.services.adminFlow.finish(adminId); await this.showList(ctx);
    }
    private async startExtra(ctx: Context, adminId: number): Promise<void> { if (!this.services.adminFlow.getData(adminId).exceptionDate) { this.services.adminFlow.start(adminId, 'waiting_exception_date', { exceptionAction: 'extra' }); await this.services.adminUi.show(ctx, 'Оберіть дату додаткового тренування.', createFlowCancelKeyboard(AdminCallbacks.ScheduleExceptions)); return; } this.services.adminFlow.transition(adminId, 'waiting_exception_extra', { exceptionAction: 'extra' }); await this.services.adminUi.show(ctx, '➕ Додаткове тренування\n\nНадішліть одним повідомленням:\nНазва\n18:00-20:00\n12\n4\n12:00', createFlowCancelKeyboard(AdminCallbacks.ScheduleExceptions)); }
    private async parseExtra(ctx: Context, adminId: number, text: string): Promise<void> { const lines = text.split('\n').map((v) => v.trim()).filter(Boolean); if (lines.length !== 5) throw new Error('Надішліть назву, час, місця, мінімум і час публікації — кожне з нового рядка.'); const [startTime, endTime] = parseRange(lines[1]); const pending = { type: 'extra' as const, title: lines[0], startTime, endTime, placesLimit: positive(lines[2]), minPlayers: nonNegative(lines[3]), publishTime: validTime(lines[4]), publishDaysBefore: 0, publicationEnabled: true }; this.services.adminFlow.setData(adminId, { pendingException: pending, exceptionAction: 'extra' }); const chats = await this.services.chats.getEnabled(); if (!chats.length) throw new Error('Спочатку додайте активний чат.'); await this.services.adminUi.show(ctx, '💬 Оберіть чат для додаткового тренування.', createExceptionChatsKeyboard(chats)); }
    private async showException(ctx: Context, adminId: number, id: string): Promise<void> { const item = await this.services.scheduleExceptions.findById(id); if (!item) throw new Error('Виняток не знайдено.'); this.services.adminFlow.start(adminId, 'idle', { exceptionId: id, exceptionDate: item.date, exceptionEntryId: item.scheduleEntryId, pendingException: item }); await this.services.adminUi.show(ctx, renderPreview(item), createExceptionCardKeyboard()); }
    private async confirmDelete(ctx: Context, adminId: number): Promise<void> { const id = this.services.adminFlow.getData(adminId).exceptionId; if (!id) return; const item = await this.services.scheduleExceptions.findById(id); if (!item) return; const training = item.scheduleEntryId ? await this.services.repositories.trainings.findAnyByTemplateSlotAndDate(item.scheduleEntryId, item.date) : undefined; await this.services.adminUi.show(ctx, training?.messageId ? 'Тренування вже опубліковано. Повернути його до регулярного розкладу?' : 'Видалити виняток? Для цієї дати знову діятиме регулярний розклад.', createExceptionDeleteKeyboard(Boolean(training?.messageId && item.type !== 'extra'))); }
    private async revertPublished(ctx: Context, adminId: number): Promise<void> { const id = this.services.adminFlow.getData(adminId).exceptionId; if (!id || !this.reconciliation) return; const item = await this.services.scheduleExceptions.findById(id); if (!item) return; const result = await this.reconciliation.revert(item); await this.services.scheduleExceptions.delete(id); if (result.trainingId) { const training = await this.services.trainings.getRequired(result.trainingId); await this.cancellationScheduler?.schedule(training, { reconcileOverdue: false }); } this.services.adminFlow.finish(adminId); await this.showList(ctx); }
    private async showUpcoming(ctx: Context): Promise<void> { const settings = await this.services.settings.get(); const today = getZonedNow(new Date(), settings.timezone).date; const templates = await this.services.repositories.templates.list(); const lines: string[] = []; for (let offset = 0; offset < 28 && lines.length < 12; offset++) { const date = addCalendarDays(today, offset); const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; for (const template of templates) for (const slot of template.slots.filter((s) => s.dayOfWeek === weekday)) { const ex = await this.services.scheduleExceptions.findForOccurrence(slot.id, date); const occurrence = this.services.occurrenceResolver.resolveRecurring(template, slot, date, ex); lines.push(`${displayDate(date)} · ${occurrence ? `${occurrence.startTime} · ${occurrence.title}${ex ? ' ← змінено' : ''}` : `❌ ${template.title}`}`); } } for (const extra of (await this.services.scheduleExceptions.listUpcoming(today)).filter((e) => e.type === 'extra')) lines.push(`${displayDate(extra.date)} · ${extra.startTime} · ${extra.title} · додаткове`); await this.services.adminUi.show(ctx, ['👀 Найближчі тренування', '', ...(lines.length ? lines.sort().slice(0, 15) : ['Немає запланованих тренувань.'])].join('\n'), createFlowCancelKeyboard(AdminCallbacks.Schedule)); }
    private async base(entryId: string) { const templates = await this.services.repositories.templates.list(); const template = templates.find((t) => t.slots.some((s) => s.id === entryId)); const slot = template?.slots.find((s) => s.id === entryId); if (!template || !slot) throw new Error('Запис розкладу більше не існує.'); return { template, slot }; }
    private async today(): Promise<string> { return getZonedNow(new Date(), (await this.services.settings.get()).timezone).date; }
    private async parseDate(value: string): Promise<string> { const short = value.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/); const year = short?.[3] ?? (await this.today()).slice(0, 4); const result = short ? `${year}-${short[2].padStart(2, '0')}-${short[1].padStart(2, '0')}` : value.trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw new Error('Введіть коректну дату, наприклад 18.08 або 2026-08-18.'); return result; }
}

function validTime(value: string): string { const v = value.trim(); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('Час має бути у форматі HH:mm.'); return v; }
function parseRange(value: string): [string, string] { const parts = value.trim().replace(/[–—]/g, '-').split('-').map(validTime); if (parts.length !== 2 || parts[0] >= parts[1]) throw new Error('Вкажіть час як 19:00-21:00.'); return [parts[0], parts[1]]; }
function positive(value: string): number { const n = Number(value.trim()); if (!Number.isInteger(n) || n < 1) throw new Error('Кількість місць має бути більшою за нуль.'); return n; }
function nonNegative(value: string): number { const n = Number(value.trim()); if (!Number.isInteger(n) || n < 0) throw new Error('Мінімум не може бути відʼємним.'); return n; }
function parseMultiple(text: string): Partial<ScheduleException> { const result: Partial<ScheduleException> = {}; for (const line of text.split('\n')) { const [rawKey, ...rest] = line.split(':'); const value = rest.join(':').trim(); const key = rawKey.trim().toLocaleLowerCase('uk'); if (key === 'час') [result.startTime, result.endTime] = parseRange(value); else if (key === 'місця') result.placesLimit = positive(value); else if (key === 'мінімум') result.minPlayers = nonNegative(value); else if (key === 'публікація') result.publishTime = validTime(value); } if (!Object.keys(result).length) throw new Error('Не знайдено змін.'); return result; }
function displayDate(date: string): string { const [year, month, day] = date.split('-'); return `${day}.${month}.${year}`; }
function renderPreview(item: Partial<ScheduleException>): string { return ['📌 Виняток', '', item.title, item.date ? displayDate(item.date) : undefined, item.type === 'cancel' ? '❌ Скасувати цю дату' : item.type === 'extra' ? '➕ Додаткове тренування' : '📌 Зміна одного тренування', item.startTime ? `🕒 ${item.startTime}–${item.endTime}` : undefined, item.placesLimit !== undefined ? `👥 Місць: ${item.placesLimit}` : undefined, item.minPlayers !== undefined ? `🎯 Мінімум: ${item.minPlayers}` : undefined, item.publicationEnabled === false ? '📤 Публікація: вручну' : item.publishDaysBefore === 0 && item.publicationEnabled ? '📤 Публікація: зараз' : item.publishTime ? `📤 Публікація: ${item.publishTime}` : undefined, '', 'Регулярний розклад не зміниться.'].filter(Boolean).join('\n'); }
