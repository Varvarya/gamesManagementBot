import { Markup } from 'telegraf';
import { TrainingTemplate } from '../../../domain/templates/template.types';
import { ChatConfig } from '../../../domain/chats/chat.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { callbackButton } from '../../callback-data';

export function createScheduleKeyboard(
    templates: TrainingTemplate[],
) {
    return Markup.inlineKeyboard([
        ...templates.map((template) => [
            callbackButton(
                `${
                    template.enabled
                        ? '🟢'
                        : '⚪'
                } ${template.title}`,
                `${AdminCallbacks.TemplatePrefix}${template.id}`,
                AdminCallbacks.TemplatePrefix,
                'schedule-entry',
            ),
        ]),
        [
            Markup.button.callback(
                '➕ Додати',
                AdminCallbacks.CreateTemplate,
            ),
            Markup.button.callback('📌 Винятки', AdminCallbacks.ScheduleExceptions),
        ],
        [Markup.button.callback('👀 Найближчі тренування', AdminCallbacks.ScheduleUpcoming)],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createTemplateKeyboard(
    template: TrainingTemplate,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '✏️ Редагувати',
                `${AdminCallbacks.TemplateEditPrefix}${template.id}`,
            ),
        ],
        [
            Markup.button.callback(
                template.enabled
                    ? '⏸ Призупинити'
                    : '▶️ Відновити',
                `${AdminCallbacks.TemplateTogglePrefix}${template.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '🗑 Видалити',
                `${AdminCallbacks.TemplateDeletePrefix}${template.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ До розкладу',
                AdminCallbacks.Schedule,
            ),
        ],
    ]);
}

export function createTemplateDeleteKeyboard(
    templateId: string,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '🗑 Видалити',
                `${AdminCallbacks.TemplateDeleteConfirmPrefix}${templateId}`,
            ),
        ],
        [
            Markup.button.callback(
                '❌ Скасувати',
                `${AdminCallbacks.TemplatePrefix}${templateId}`,
            ),
        ],
    ]);
}

export function createTemplateDeleteWithExceptionsKeyboard(templateId: string) {
    return Markup.inlineKeyboard([[Markup.button.callback('🗑 Видалити разом', `${AdminCallbacks.TemplateDeleteWithExceptionsPrefix}${templateId}`)], [Markup.button.callback('↩️ Скасувати', `${AdminCallbacks.TemplatePrefix}${templateId}`)]]);
}

export function createTemplatePreviewKeyboard(
    mode: 'create' | 'edit',
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                mode === 'create'
                    ? '✅ Підтвердити створення'
                    : '✅ Підтвердити зміни',
                mode === 'create'
                    ? AdminCallbacks.ConfirmCreateTemplate
                    : AdminCallbacks.ConfirmEditTemplate,
            ),
        ],
        [
            Markup.button.callback(
                '💬 Змінити чат',
                AdminCallbacks.SelectTemplateChat,
            ),
        ],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.BackFromTemplatePreview)],
        [
            Markup.button.callback(
                '❌ Скасувати',
                mode === 'create'
                    ? AdminCallbacks.CancelCreateTemplate
                    : AdminCallbacks.CancelEditTemplate,
            ),
        ],
    ]);
}

export function createTemplateChatSelectionKeyboard(
    chats: ChatConfig[],
    mode: 'create' | 'edit',
) {
    return Markup.inlineKeyboard([
        ...chats.map(chat => [
            Markup.button.callback(
                `💬 ${chat.name}`,
                `${AdminCallbacks.TemplateChatPrefix}${chat.id}`,
            ),
        ]),
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.BackFromTemplateChat,
            ),
        ],
        [
            Markup.button.callback(
                '❌ Скасувати',
                mode === 'create'
                    ? AdminCallbacks.CancelCreateTemplate
                    : AdminCallbacks.CancelEditTemplate,
            ),
        ],
    ]);
}

export function createNoTemplateChatsKeyboard(
    mode: 'create' | 'edit',
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '💬 До чатів',
                AdminCallbacks.Chats,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.BackFromTemplateChat,
            ),
        ],
        [
            Markup.button.callback(
                '❌ Скасувати',
                mode === 'create'
                    ? AdminCallbacks.CancelCreateTemplate
                    : AdminCallbacks.CancelEditTemplate,
            ),
        ],
    ]);
}
