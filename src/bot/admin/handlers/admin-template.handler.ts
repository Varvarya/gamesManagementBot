import { Context } from 'telegraf';

import { ServicesContext } from '../../../app/services.context';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { TrainingTemplate } from '../../../domain/templates/template.types';

import { AdminCallbacks } from '../callbacks/admin-callbacks';

import {
    createScheduleKeyboard,
    createTemplateDeleteKeyboard,
    createTemplateKeyboard,
    createTemplateDeleteWithExceptionsKeyboard,
} from '../keyboards/template.keyboard';

import {
    formatDay,
    formatTimeRange,
    renderTemplateCard,
} from '../ui/admin-formatters';

export class AdminTemplateHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly templateScheduler: TemplateSchedulerService,
    ) {}

    canHandle(
        callback: string,
    ): boolean {
        return (
            callback ===
            AdminCallbacks.Schedule ||
            [
                AdminCallbacks.TemplatePrefix,
                AdminCallbacks.TemplateTogglePrefix,
                AdminCallbacks.TemplateDeletePrefix,
                AdminCallbacks.TemplateDeleteConfirmPrefix,
                AdminCallbacks.TemplateDeleteWithExceptionsPrefix,
            ].some((prefix) => callback.startsWith(prefix))
        );
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (
            callback ===
            AdminCallbacks.Schedule
        ) {
            if (ctx.from) this.services.adminFlow.finish(ctx.from.id);
            await this.showSchedule(
                ctx,
            );

            return;
        }

        if (
            callback.startsWith(AdminCallbacks.TemplateDeleteWithExceptionsPrefix)
        ) { await this.deleteTemplate(ctx, callback.replace(AdminCallbacks.TemplateDeleteWithExceptionsPrefix, ''), true); return; }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateDeleteConfirmPrefix,
            )
        ) {
            const templateId =
                callback.replace(
                    AdminCallbacks.TemplateDeleteConfirmPrefix,
                    '',
                );

            await this.deleteTemplate(
                ctx,
                templateId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateDeletePrefix,
            )
        ) {
            const templateId =
                callback.replace(
                    AdminCallbacks.TemplateDeletePrefix,
                    '',
                );

            await this.confirmDelete(
                ctx,
                templateId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateTogglePrefix,
            )
        ) {
            const templateId =
                callback.replace(
                    AdminCallbacks.TemplateTogglePrefix,
                    '',
                );

            await this.toggleTemplate(
                ctx,
                templateId,
            );

            return;
        }

        const templateId =
            callback.replace(
                AdminCallbacks.TemplatePrefix,
                '',
            );

        await this.showTemplate(
            ctx,
            templateId,
        );
    }

    private async showSchedule(
        ctx: Context,
    ): Promise<void> {
        const settings =
            await this.services.repositories.settings.get();

        const templates =
            await this.services.templates.listByClubId(
                settings.clubId,
            );

        templates.sort(
            (
                first,
                second,
            ) =>
                this.compareTemplates(
                    first,
                    second,
                ),
        );

        await this.services.adminUi.show(
            ctx,
            [
                '📅 Розклад',
                '',
                templates.length > 0 ? templates.flatMap((template) => template.slots.map((slot) => `${formatDay(slot.dayOfWeek).slice(0, 2)} · ${slot.startTime}–${slot.endTime} · ${template.title}${template.enabled && slot.enabled ? '' : ' · пауза'}`)).map((line, index) => `${index + 1}. ${line}`).join('\n') : 'Записів поки немає.',
            ].join('\n'),
            createScheduleKeyboard(
                templates,
            ),
        );
    }

    private async showTemplate(
        ctx: Context,
        templateId: string,
    ): Promise<void> {
        const template =
            await this.services.templates.getRequired(
                templateId,
            );
        const chat = await this.services.chats.getById(template.chatId);

        await this.services.adminUi.show(
            ctx,
            renderTemplateCard(
                template,
                chat?.name,
            ),
            createTemplateKeyboard(
                template,
            ),
        );
    }

    private async toggleTemplate(
        ctx: Context,
        templateId: string,
    ): Promise<void> {
        const template =
            await this.services.templates.getRequired(
                templateId,
            );

        const updated =
            template.enabled
                ? await this.templateScheduler.disable(
                    templateId,
                )
                : await this.templateScheduler.enable(
                    templateId,
                );

        await this.services.adminUi.show(
            ctx,
            renderTemplateCard(updated),
            createTemplateKeyboard(
                updated,
            ),
        );
    }

    private async confirmDelete(
        ctx: Context,
        templateId: string,
    ): Promise<void> {
        const template =
            await this.services.templates.getRequired(
                templateId,
            );

        const slotLines =
            template.slots.length > 0
                ? template.slots.flatMap(
                    (
                        slot,
                        index,
                    ) => [
                        index > 0
                            ? ''
                            : undefined,
                        `📅 ${formatDay(
                            slot.dayOfWeek,
                        )}`,
                        `🕐 ${formatTimeRange(
                            slot.startTime,
                            slot.endTime,
                        )}`,
                    ],
                )
                : ['⚠️ У розкладі немає часу'];

        await this.services.adminUi.show(
            ctx,
            [
                `Видалити «${template.title}» з розкладу?`,
                '',
                ...slotLines,
                '',
                'Уже опубліковані тренування не буде видалено.',
            ]
                .filter(
                    (line): line is string =>
                        line !== undefined,
                )
                .join('\n'),
            createTemplateDeleteKeyboard(
                template.id,
            ),
        );
    }

    private async deleteTemplate(
        ctx: Context,
        templateId: string,
        deleteFutureExceptions = false,
    ): Promise<void> {
        try { await this.templateScheduler.delete(templateId, deleteFutureExceptions); }
        catch (error) { const match = error instanceof Error ? error.message.match(/^SCHEDULE_HAS_EXCEPTIONS:(\d+)$/) : undefined; if (match) { await this.services.adminUi.show(ctx, `⚠️ Для цього розкладу є ${match[1]} майбутні винятки.`, createTemplateDeleteWithExceptionsKeyboard(templateId)); return; } throw error; }
        const settings = await this.services.repositories.settings.get();
        const templates = await this.services.templates.listByClubId(settings.clubId);
        templates.sort((first, second) => this.compareTemplates(first, second));
        await this.services.adminUi.show(ctx, templates.length ? '📅 Розклад' : '📅 Розклад\n\nЗаписів поки немає.', createScheduleKeyboard(templates));
    }

    private compareTemplates(
        first: TrainingTemplate,
        second: TrainingTemplate,
    ): number {
        const firstSlot =
            this.getFirstEnabledSlot(
                first,
            );

        const secondSlot =
            this.getFirstEnabledSlot(
                second,
            );

        if (
            !firstSlot &&
            !secondSlot
        ) {
            return first.title.localeCompare(
                second.title,
                'uk',
            );
        }

        if (!firstSlot) {
            return 1;
        }

        if (!secondSlot) {
            return -1;
        }

        if (
            firstSlot.dayOfWeek !==
            secondSlot.dayOfWeek
        ) {
            return (
                firstSlot.dayOfWeek -
                secondSlot.dayOfWeek
            );
        }

        const timeComparison =
            firstSlot.startTime.localeCompare(
                secondSlot.startTime,
            );

        if (timeComparison !== 0) {
            return timeComparison;
        }

        return first.title.localeCompare(
            second.title,
            'uk',
        );
    }

    private getFirstEnabledSlot(
        template: TrainingTemplate,
    ): TrainingTemplate['slots'][number] | undefined {
        const enabledSlots =
            template.slots
                .filter(
                    slot =>
                        slot.enabled,
                )
                .sort(
                    (
                        first,
                        second,
                    ) => {
                        if (
                            first.dayOfWeek !==
                            second.dayOfWeek
                        ) {
                            return (
                                first.dayOfWeek -
                                second.dayOfWeek
                            );
                        }

                        return first.startTime.localeCompare(
                            second.startTime,
                        );
                    },
                );

        return (
            enabledSlots[0] ??
            template.slots[0]
        );
    }
}
