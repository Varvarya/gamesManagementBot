import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createTemplatePreviewKeyboard } from '../keyboards/template.keyboard';
import { PendingTemplate } from './admin-flow.types';

const DAY_ALIASES: Record<string, number> = {
    '1': 1,
    'пн': 1,
    'понеділок': 1,
    'понедельник': 1,

    '2': 2,
    'вт': 2,
    'вівторок': 2,
    'вторник': 2,

    '3': 3,
    'ср': 3,
    'середа': 3,
    'среда': 3,

    '4': 4,
    'чт': 4,
    'четвер': 4,
    'четверг': 4,

    '5': 5,
    'пт': 5,
    "п'ятниця": 5,
    'пятниця': 5,
    'пятница': 5,

    '6': 6,
    'сб': 6,
    'субота': 6,
    'суббота': 6,

    '7': 7,
    'нд': 7,
    'неділя': 7,
    'вс': 7,
    'воскресенье': 7,
};

export class TemplateFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly templateScheduler: TemplateSchedulerService,
    ) {}

    canHandleCallback(callback: string): boolean {
        return (
            callback === AdminCallbacks.CreateTemplate ||
            callback ===
            AdminCallbacks.ConfirmCreateTemplate ||
            callback ===
            AdminCallbacks.CancelCreateTemplate ||
            callback ===
            AdminCallbacks.ConfirmEditTemplate ||
            callback ===
            AdminCallbacks.CancelEditTemplate ||
            callback.startsWith(
                AdminCallbacks.TemplateEditPrefix,
            )
        );
    }

    async handleCallback(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        if (callback === AdminCallbacks.CreateTemplate) {
            await this.startCreate(ctx, adminId);
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateEditPrefix,
            )
        ) {
            const templateId = callback.replace(
                AdminCallbacks.TemplateEditPrefix,
                '',
            );

            await this.startEdit(
                ctx,
                adminId,
                templateId,
            );

            return;
        }

        if (
            callback ===
            AdminCallbacks.ConfirmCreateTemplate
        ) {
            await this.confirmCreate(ctx, adminId);
            return;
        }

        if (
            callback ===
            AdminCallbacks.ConfirmEditTemplate
        ) {
            await this.confirmEdit(ctx, adminId);
            return;
        }

        if (
            callback ===
            AdminCallbacks.CancelCreateTemplate ||
            callback ===
            AdminCallbacks.CancelEditTemplate
        ) {
            this.services.adminFlow.reset(adminId);

            await ctx.editMessageText(
                '❌ Дію скасовано',
            );
        }
    }

    canHandleText(adminId: number): boolean {
        const state =
            this.services.adminFlow.getState(adminId);

        return (
            state ===
            'waiting_template_quick_input' ||
            state ===
            'waiting_template_edit_input'
        );
    }

    async handleText(
        ctx: Context,
        text: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        const state =
            this.services.adminFlow.getState(adminId);

        const pendingTemplate =
            this.parseTemplateInput(text);

        if (!pendingTemplate) {
            await ctx.reply(
                [
                    '❌ Не вдалося розпізнати дані',
                    '',
                    'Приклад:',
                    '',
                    'Назва: Вечірнє тренування',
                    'Ср',
                    '19:30-21:30',
                    '20',
                    '8',
                    'Вт 12:00',
                ].join('\n'),
            );

            return;
        }

        this.services.adminFlow.setData(
            adminId,
            {
                pendingTemplate,
            },
        );

        const mode =
            state ===
            'waiting_template_edit_input'
                ? 'edit'
                : 'create';

        await ctx.reply(
            this.renderPreview(pendingTemplate),
            createTemplatePreviewKeyboard(mode),
        );
    }

    private async startCreate(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        this.services.adminFlow.transition(
            adminId,
            'waiting_template_quick_input',
        );

        await ctx.editMessageText(
            [
                '➕ Новий шаблон',
                '',
                'Надішліть дані одним повідомленням:',
                '',
                'Назва: Вечірнє тренування',
                'Ср',
                '19:30-21:30',
                '20',
                '8',
                'Вт 12:00',
                '',
                'Назва необовʼязкова',
            ].join('\n'),
        );
    }

    private async startEdit(
        ctx: Context,
        adminId: number,
        templateId: string,
    ): Promise<void> {
        const template =
            await this.services.templates.getRequired(
                templateId,
            );

        this.services.adminFlow.transition(
            adminId,
            'waiting_template_edit_input',
            {
                templateId,
            },
        );

        await ctx.editMessageText(
            [
                '✏️ Редагування шаблону',
                '',
                'Скопіюйте блок нижче, змініть потрібні дані та надішліть:',
                '',
                `Назва: ${template.title}`,
                this.getDayTitle(template.dayOfWeek),
                `${template.startTime}-${template.endTime}`,
                String(template.placesLimit),
                String(template.minPlayers),
                `${this.getDayTitle(template.publishDayOfWeek)} ${template.publishTime}`,
            ].join('\n'),
        );
    }

    private async confirmCreate(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(adminId);

        if (!data.pendingTemplate) {
            throw new Error(
                'Pending template not found',
            );
        }

        const settings =
            await this.services.repositories.settings.get();

        if (!settings.chatId) {
            throw new Error(
                'Club chatId is missing',
            );
        }

        await this.templateScheduler.create({
            clubId: settings.clubId,
            chatId: settings.chatId,
            ...data.pendingTemplate,
            enabled: true,
        });

        this.services.adminFlow.reset(adminId);

        await ctx.editMessageText(
            '✅ Шаблон створено',
        );
    }

    private async confirmEdit(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(adminId);

        if (
            !data.templateId ||
            !data.pendingTemplate
        ) {
            throw new Error(
                'Template edit data is incomplete',
            );
        }

        await this.templateScheduler.update(
            data.templateId,
            data.pendingTemplate,
        );

        this.services.adminFlow.reset(adminId);

        await ctx.editMessageText(
            '✅ Шаблон оновлено',
        );
    }

    private parseTemplateInput(
        value: string,
    ): PendingTemplate | undefined {
        const lines = value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        let title: string | undefined;
        let dataLines = lines;

        if (/^назва\s*:/i.test(lines[0] ?? '')) {
            title = lines[0]
                .replace(/^назва\s*:/i, '')
                .trim();

            if (!title) {
                return undefined;
            }

            dataLines = lines.slice(1);
        }

        if (dataLines.length !== 5) {
            return undefined;
        }

        const dayOfWeek =
            this.parseDay(dataLines[0]);

        const timeRange =
            this.parseTimeRange(dataLines[1]);

        const placesLimit =
            Number(dataLines[2]);

        const minPlayers =
            Number(dataLines[3]);

        const publish =
            this.parsePublishValue(dataLines[4]);

        if (
            !dayOfWeek ||
            !timeRange ||
            !Number.isInteger(placesLimit) ||
            placesLimit < 1 ||
            !Number.isInteger(minPlayers) ||
            minPlayers < 0 ||
            minPlayers > placesLimit ||
            !publish
        ) {
            return undefined;
        }

        return {
            title:
                title ??
                `Тренування ${this.getDayTitle(dayOfWeek)} ${timeRange.startTime}`,

            dayOfWeek,

            startTime: timeRange.startTime,
            endTime: timeRange.endTime,

            placesLimit,
            minPlayers,

            publishDayOfWeek:
            publish.dayOfWeek,

            publishTime: publish.time,
        };
    }

    private parsePublishValue(
        value: string,
    ):
        | {
        dayOfWeek: number;
        time: string;
    }
        | undefined {
        const match = value.match(
            /^(\S+)\s+(\d{1,2}:\d{2})$/,
        );

        if (!match) {
            return undefined;
        }

        const dayOfWeek =
            this.parseDay(match[1]);

        const time =
            this.normalizeTime(match[2]);

        if (
            !dayOfWeek ||
            !this.isValidTime(time)
        ) {
            return undefined;
        }

        return {
            dayOfWeek,
            time,
        };
    }

    private parseDay(
        value: string,
    ): number | undefined {
        const normalized = value
            .trim()
            .toLowerCase()
            .replace('.', '');

        return DAY_ALIASES[normalized];
    }

    private parseTimeRange(
        value: string,
    ):
        | {
        startTime: string;
        endTime: string;
    }
        | undefined {
        const match = value.match(
            /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/,
        );

        if (!match) {
            return undefined;
        }

        const startTime =
            this.normalizeTime(match[1]);

        const endTime =
            this.normalizeTime(match[2]);

        if (
            !this.isValidTime(startTime) ||
            !this.isValidTime(endTime) ||
            this.timeToMinutes(endTime) <=
            this.timeToMinutes(startTime)
        ) {
            return undefined;
        }

        return {
            startTime,
            endTime,
        };
    }

    private normalizeTime(
        value: string,
    ): string {
        const [hours, minutes] =
            value.split(':');

        return `${hours.padStart(2, '0')}:${minutes}`;
    }

    private isValidTime(
        value: string,
    ): boolean {
        if (!/^\d{2}:\d{2}$/.test(value)) {
            return false;
        }

        const [hours, minutes] =
            value.split(':').map(Number);

        return (
            Number.isInteger(hours) &&
            Number.isInteger(minutes) &&
            hours >= 0 &&
            hours <= 23 &&
            minutes >= 0 &&
            minutes <= 59
        );
    }

    private timeToMinutes(
        value: string,
    ): number {
        const [hours, minutes] =
            value.split(':').map(Number);

        return hours * 60 + minutes;
    }

    private renderPreview(
        template: PendingTemplate,
    ): string {
        return [
            '👀 Перевірте шаблон',
            '',
            `🏸 ${template.title}`,
            `📅 ${this.getDayTitle(template.dayOfWeek)}`,
            `🕐 ${template.startTime}–${template.endTime}`,
            `👥 ${template.placesLimit} місць`,
            `🔻 Мінімум: ${template.minPlayers}`,
            '',
            `📣 Публікація: ${this.getDayTitle(template.publishDayOfWeek)} ${template.publishTime}`,
        ].join('\n');
    }

    private getDayTitle(
        day: number,
    ): string {
        const titles: Record<number, string> = {
            1: 'Пн',
            2: 'Вт',
            3: 'Ср',
            4: 'Чт',
            5: 'Пт',
            6: 'Сб',
            7: 'Нд',
        };

        return titles[day] ?? String(day);
    }
}