import { RepositoriesContext } from '../../app/repositories.context';
import { TrainingTemplate, TrainingTemplateSlot } from '../templates/template.types';

export type ClubReadinessWarningCode = 'missing_name' | 'missing_owner' | 'missing_chat' | 'chat_unavailable' | 'missing_schedule' | 'missing_publication';
export type ClubReadinessWarning = { code: ClubReadinessWarningCode; message: string; repair: 'identity' | 'admins' | 'chat' | 'schedule' };
export type ClubReadiness = {
    ready: boolean;
    identityConfigured: boolean;
    ownerConfigured: boolean;
    chatConfigured: boolean;
    scheduleConfigured: boolean;
    publicationConfigured: boolean;
    warnings: ClubReadinessWarning[];
};

/** Derived on every call. Repositories remain the only source of truth. */
export class ClubReadinessService {
    constructor(private readonly repositories: RepositoriesContext) {}

    async calculate(): Promise<ClubReadiness> {
        const [settings, chats, schedules] = await Promise.all([
            this.repositories.settings.get(), this.repositories.chats.getAll(), this.repositories.templates.list(),
        ]);
        const identityConfigured = settings.title.trim().length > 0;
        const ownerConfigured = settings.admins.some((admin) => admin.role === 'owner' && validTelegramId(admin.telegramUserId));
        const enabledChats = chats.filter((chat) => chat.enabled);
        const usableChatIds = new Set(enabledChats.filter((chat) => chat.available !== false).map((chat) => chat.id));
        const chatConfigured = enabledChats.length > 0;
        const activeSchedules = schedules.filter((schedule) => schedule.enabled && schedule.slots.some(validEnabledSlot));
        const scheduleConfigured = activeSchedules.length > 0;
        const publicationConfigured = activeSchedules.some((schedule) => validPublication(schedule, usableChatIds));
        const warnings: ClubReadinessWarning[] = [];
        if (!identityConfigured) warnings.push({ code: 'missing_name', message: 'не вказано назву клубу', repair: 'identity' });
        if (!ownerConfigured) warnings.push({ code: 'missing_owner', message: 'не призначено owner', repair: 'admins' });
        if (!chatConfigured) warnings.push({ code: 'missing_chat', message: 'не додано активний чат', repair: 'chat' });
        else if (!usableChatIds.size) warnings.push({ code: 'chat_unavailable', message: 'бот не має доступу до активного чату', repair: 'chat' });
        if (!scheduleConfigured) warnings.push({ code: 'missing_schedule', message: 'немає активного розкладу', repair: 'schedule' });
        else if (!publicationConfigured) warnings.push({ code: 'missing_publication', message: 'для розкладу не налаштовано публікацію', repair: 'schedule' });
        return { ready: warnings.length === 0, identityConfigured, ownerConfigured, chatConfigured, scheduleConfigured, publicationConfigured, warnings };
    }
}

function validTelegramId(value: unknown): boolean { const id = Number(value); return Number.isSafeInteger(id) && id > 0; }
function validTime(value: unknown): boolean { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function validEnabledSlot(slot: TrainingTemplateSlot): boolean {
    return slot.enabled && Number.isInteger(slot.dayOfWeek) && slot.dayOfWeek >= 1 && slot.dayOfWeek <= 7
        && validTime(slot.startTime) && validTime(slot.endTime) && slot.startTime < slot.endTime;
}
function validPublication(schedule: TrainingTemplate, usableChatIds: ReadonlySet<number>): boolean {
    return usableChatIds.has(schedule.chatId) && validTime(schedule.publishTime)
        && Number.isInteger(schedule.publishDaysBefore) && schedule.publishDaysBefore >= 0
        && schedule.slots.some((slot) => validEnabledSlot(slot) && validTime(slot.publishTime ?? schedule.publishTime));
}
