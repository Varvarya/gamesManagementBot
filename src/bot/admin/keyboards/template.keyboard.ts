import { Markup } from 'telegraf';
import { TrainingTemplate } from '../../../domain/templates/template.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createScheduleKeyboard(
    templates: TrainingTemplate[],
) {
    return Markup.inlineKeyboard([
        ...templates.map((template) => [
            Markup.button.callback(
                `${
                    template.enabled
                        ? '🟢'
                        : '⚪️'
                } ${template.title}`,
                `${AdminCallbacks.TemplatePrefix}${template.id}`,
            ),
        ]),
        [
            Markup.button.callback(
                '➕ Новий шаблон',
                AdminCallbacks.CreateTemplate,
            ),
        ],
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
                    ? '⏸ Вимкнути'
                    : '▶️ Увімкнути',
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
                '🗑 Так, видалити',
                `${AdminCallbacks.TemplateDeleteConfirmPrefix}${templateId}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                `${AdminCallbacks.TemplatePrefix}${templateId}`,
            ),
        ],
    ]);
}

export function createTemplatePreviewKeyboard(
    mode: 'create' | 'edit',
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                mode === 'create'
                    ? '✅ Створити'
                    : '✅ Зберегти зміни',
                mode === 'create'
                    ? AdminCallbacks.ConfirmCreateTemplate
                    : AdminCallbacks.ConfirmEditTemplate,
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