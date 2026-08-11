import { Markup } from 'telegraf';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { ScheduleException } from '../../../domain/schedule-exceptions/schedule-exception.types';
import { TrainingTemplateSlot } from '../../../domain/templates/template.types';

export function createExceptionsKeyboard(items: ScheduleException[], history = false) {
    return Markup.inlineKeyboard([
        ...items.slice(0, 20).map((item) => [Markup.button.callback(`${icon(item)} ${displayDate(item.date)} · ${item.title ?? (item.type === 'extra' ? 'Додаткове тренування' : 'Зміна розкладу')}`, `${AdminCallbacks.ScheduleExceptionViewPrefix}${item.id}`)]),
        ...(!history ? [[Markup.button.callback('➕ Додати виняток', AdminCallbacks.ScheduleExceptionAdd)], [Markup.button.callback('📚 Історія', AdminCallbacks.ScheduleExceptionHistory)]] : []),
        [Markup.button.callback('◀️ До розкладу', AdminCallbacks.Schedule)],
    ]);
}
export function createOccurrenceSelectionKeyboard(slots: Array<{ slot: TrainingTemplateSlot; title: string }>) {
    return Markup.inlineKeyboard([
        ...slots.map(({ slot, title }) => [Markup.button.callback(`${slot.startTime}–${slot.endTime} · ${title}`, `${AdminCallbacks.ScheduleExceptionEntryPrefix}${slot.id}`)]),
        [Markup.button.callback('➕ Додаткове тренування', AdminCallbacks.ScheduleExceptionExtra)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.ScheduleExceptions)],
    ]);
}
export function createExceptionActionsKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('❌ Скасувати тренування', `${AdminCallbacks.ScheduleExceptionActionPrefix}cancel`)],
        [Markup.button.callback('🕒 Змінити час', `${AdminCallbacks.ScheduleExceptionActionPrefix}time`), Markup.button.callback('👥 Змінити місця', `${AdminCallbacks.ScheduleExceptionActionPrefix}places`)],
        [Markup.button.callback('🎯 Змінити мінімум', `${AdminCallbacks.ScheduleExceptionActionPrefix}minimum`), Markup.button.callback('💬 Змінити чат', `${AdminCallbacks.ScheduleExceptionActionPrefix}chat`)],
        [Markup.button.callback('📤 Змінити публікацію', `${AdminCallbacks.ScheduleExceptionActionPrefix}publication`)],
        [Markup.button.callback('⚡️ Опублікувати зараз', `${AdminCallbacks.ScheduleExceptionActionPrefix}publication_now`), Markup.button.callback('✋ Вручну', `${AdminCallbacks.ScheduleExceptionActionPrefix}publication_manual`)],
        [Markup.button.callback('✏️ Кілька параметрів', `${AdminCallbacks.ScheduleExceptionActionPrefix}multiple`)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.ScheduleExceptions)],
    ]);
}
export function createExceptionConfirmKeyboard() { return Markup.inlineKeyboard([[Markup.button.callback('✅ Зберегти', AdminCallbacks.ScheduleExceptionConfirm)], [Markup.button.callback('❌ Скасувати', AdminCallbacks.ScheduleExceptions)]]); }
export function createExceptionCardKeyboard() { return Markup.inlineKeyboard([[Markup.button.callback('✏️ Редагувати', `${AdminCallbacks.ScheduleExceptionActionPrefix}edit`)], [Markup.button.callback('🗑 Видалити виняток', AdminCallbacks.ScheduleExceptionDelete)], [Markup.button.callback('◀️ Назад', AdminCallbacks.ScheduleExceptions)]]); }
export function createExceptionDeleteKeyboard(canRevert = false) { return Markup.inlineKeyboard([...(canRevert ? [[Markup.button.callback('🔄 Повернути', AdminCallbacks.ScheduleExceptionRevertConfirm)]] : []), [Markup.button.callback('🗑 Видалити лише виняток', AdminCallbacks.ScheduleExceptionDeleteConfirm)], [Markup.button.callback('❌ Скасувати', AdminCallbacks.ScheduleExceptions)]]); }
export function createExceptionChatsKeyboard(chats: Array<{ id: number; name: string }>) { return Markup.inlineKeyboard([...chats.map((chat) => [Markup.button.callback(chat.name, `${AdminCallbacks.ScheduleExceptionChatPrefix}${chat.id}`)]), [Markup.button.callback('◀️ Назад', AdminCallbacks.ScheduleExceptions)]]); }
function icon(item: ScheduleException): string { return item.type === 'cancel' ? '❌' : item.type === 'extra' ? '➕' : '📌'; }
function displayDate(date: string): string { const [, month, day] = date.split('-'); return `${day}.${month}`; }
