import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { TrainingTemplate } from '../../../domain/templates/template.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import {
    createScheduleKeyboard,
    createTemplateDeleteKeyboard,
    createTemplateKeyboard,
} from '../keyboards/template.keyboard';

export class AdminTemplateHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly templateScheduler: TemplateSchedulerService,
    ) {}

    canHandle(callback: string): boolean {
        return (
            callback === AdminCallbacks.Schedule ||
            callback.startsWith(
                AdminCallbacks.TemplatePrefix,
            )
        );
    }

    async handle(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        if (callback === AdminCallbacks.Schedule) {
            await this.showSchedule(ctx);
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateDeleteConfirmPrefix,
            )
        ) {
            await this.deleteTemplate(
                ctx,
                callback.replace(
                    AdminCallbacks.TemplateDeleteConfirmPrefix,
                    '',
                ),
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateDeletePrefix,
            )
        ) {
            await this.confirmDelete(
                ctx,
                callback.replace(
                    AdminCallbacks.TemplateDeletePrefix,
                    '',
                ),
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateTogglePrefix,
            )
        ) {
            await this.toggleTemplate(
                ctx,
                callback.replace(
                    AdminCallbacks.TemplateTogglePrefix,
                    '',
                ),
            );

            return;
        }

        await this.showTemplate(
            ctx,
            callback.replace(
                AdminCallbacks.TemplatePrefix,
                '',
            ),
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

        await this.services.adminUi.show(
            ctx,
            [
                '📅 Розклад тренувань',
                '',
                templates.length > 0
                    ? `Налаштовано шаблонів: ${templates.length}`
                    : 'Шаблонів поки немає',
                '',
                'Оберіть шаблон або створіть новий',
            ].join('\n'),
            createScheduleKeyboard(templates),
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

        await ctx.editMessageText(
            this.render(template),
            createTemplateKeyboard(template),
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

        const updated = template.enabled
            ? await this.templateScheduler.disable(
                templateId,
            )
            : await this.templateScheduler.enable(
                templateId,
            );

        await ctx.editMessageText(
            this.render(updated),
            createTemplateKeyboard(updated),
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

        await ctx.editMessageText(
            [
                '🗑 Видалити шаблон?',
                '',
                `🏸 ${template.title}`,
            ].join('\n'),
            createTemplateDeleteKeyboard(
                template.id,
            ),
        );
    }

    private async deleteTemplate(
        ctx: Context,
        templateId: string,
    ): Promise<void> {
        await this.templateScheduler.delete(
            templateId,
        );

        await this.showSchedule(ctx);
    }

    private render(
        template: TrainingTemplate,
    ): string {
        return [
            `${
                template.enabled
                    ? '🟢'
                    : '⚪️'
            } ${template.title}`,
            '',
            `📅 День: ${template.dayOfWeek}`,
            `🕐 ${template.startTime}–${template.endTime}`,
            '',
            `👥 Місць: ${template.placesLimit}`,
            `🔻 Мінімум: ${template.minPlayers}`,
            '',
            `📣 День ${template.publishDayOfWeek} ${template.publishTime}`,
        ].join('\n');
    }
}