import {
    Context,
    Markup,
} from 'telegraf';

import { ServicesContext } from '../../../app/services.context';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { CreateTrainingTemplateSlotInput } from '../../../domain/templates/template.types';

import { AdminCallbacks } from '../callbacks/admin-callbacks';

import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import {
    createTemplateKeyboard,
    createTemplatePreviewKeyboard,
} from '../keyboards/template.keyboard';

import {
    formatDay,
    renderTemplateCard,
} from '../ui/admin-formatters';

import { PendingTemplate } from './admin-flow.types';

const DAY_ALIASES: Record<string, number> = {
    '1': 1,
    пн: 1,
    понеділок: 1,
    понедельник: 1,

    '2': 2,
    вт: 2,
    вівторок: 2,
    вторник: 2,

    '3': 3,
    ср: 3,
    середа: 3,
    среда: 3,

    '4': 4,
    чт: 4,
    четвер: 4,
    четверг: 4,

    '5': 5,
    пт: 5,
    "п'ятниця": 5,
    пятниця: 5,
    пятница: 5,

    '6': 6,
    сб: 6,
    субота: 6,
    суббота: 6,

    '7': 7,
    нд: 7,
    неділя: 7,
    вс: 7,
    воскресенье: 7,
};

type TemplateFlowMode =
    | 'create'
    | 'edit';

export class TemplateFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly templateScheduler: TemplateSchedulerService,
    ) {}

    canHandleCallback(
        callback: string,
    ): boolean {
        return (
            callback === AdminCallbacks.CreateTemplate ||
            callback === AdminCallbacks.ConfirmCreateTemplate ||
            callback === AdminCallbacks.CancelCreateTemplate ||
            callback === AdminCallbacks.ConfirmEditTemplate ||
            callback === AdminCallbacks.CancelEditTemplate ||
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

        if (
            callback ===
            AdminCallbacks.CreateTemplate
        ) {
            await this.startCreate(
                ctx,
                adminId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateEditPrefix,
            )
        ) {
            const templateId =
                callback.replace(
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
            await this.confirmCreate(
                ctx,
                adminId,
            );

            return;
        }

        if (
            callback ===
            AdminCallbacks.ConfirmEditTemplate
        ) {
            await this.confirmEdit(
                ctx,
                adminId,
            );

            return;
        }

        if (
            callback ===
            AdminCallbacks.CancelCreateTemplate ||
            callback ===
            AdminCallbacks.CancelEditTemplate
        ) {
            await this.cancel(
                ctx,
                adminId,
            );
        }
    }

    canHandleText(
        adminId: number,
    ): boolean {
        const state =
            this.services.adminFlow.getState(
                adminId,
            );

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
            this.services.adminFlow.getState(
                adminId,
            );

        const mode: TemplateFlowMode =
            state ===
            'waiting_template_edit_input'
                ? 'edit'
                : 'create';

        const pendingTemplate =
            this.parseTemplateInput(
                text,
            );

        if (!pendingTemplate) {
            await this.showFormatError(
                ctx,
                adminId,
                mode,
            );

            return;
        }

        this.services.adminFlow.setData(
            adminId,
            {
                pendingTemplate,
            },
        );

        await this.services.adminUi.show(
            ctx,
            this.renderPreview(
                pendingTemplate,
            ),
            createTemplatePreviewKeyboard(
                mode,
            ),
        );
    }

    private async startCreate(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        this.services.adminFlow.start(
            adminId,
            'waiting_template_quick_input',
        );

        await this.services.adminUi.show(
            ctx,
            [
                '➕ Новий шаблон',
                '',
                'Надішліть дані одним повідомленням',
                '',
                'Назва: Вечірні тренування',
                'Ср 19:30-21:30',
                'Пт 18:00-20:00',
                '20',
                '8',
                '12:00',
                '',
                'Формат:',
                '1. Назва — необовʼязково',
                '2. Один або кілька рядків: день і час тренування',
                '3. Кількість місць',
                '4. Мінімум гравців',
                '5. Час публікації',
                '',
                'Публікація буде за день до кожного тренування.',
            ].join('\n'),
            createFlowCancelKeyboard(
                AdminCallbacks.Schedule,
            ),
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

        if (!template.slots.length) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'У шаблоні немає слотів для редагування.',
                createFlowCancelKeyboard(
                    `${AdminCallbacks.TemplatePrefix}${template.id}`,
                ),
            );

            return;
        }

        this.services.adminFlow.start(
            adminId,
            'waiting_template_edit_input',
            {
                templateId,
            },
        );

        await this.services.adminUi.show(
            ctx,
            [
                '✏️ Редагування шаблону',
                '',
                'Скопіюйте блок нижче, змініть потрібні дані та надішліть його',
                '',
                `Назва: ${template.title}`,
                ...template.slots.map(
                    slot =>
                        `${this.getShortDayTitle(
                            slot.dayOfWeek,
                        )} ${slot.startTime}-${slot.endTime}`,
                ),
                String(
                    template.placesLimit,
                ),
                String(
                    template.minPlayers,
                ),
                template.publishTime,
            ].join('\n'),
            createFlowCancelKeyboard(
                `${AdminCallbacks.TemplatePrefix}${template.id}`,
            ),
        );
    }

    private async confirmCreate(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        if (!data.pendingTemplate) {
            this.services.adminFlow.finish(
                adminId,
            );

            await this.services.adminUi.replaceWithError(
                ctx,
                'Дані шаблону не знайдені. Почніть створення ще раз.',
                this.createBackToScheduleKeyboard(),
            );

            return;
        }

        const settings =
            await this.services.repositories.settings.get();

        if (!settings.chatId) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'Спочатку потрібно налаштувати груповий чат клубу.',
                this.createBackToScheduleKeyboard(),
            );

            return;
        }

        const template =
            await this.templateScheduler.create({
                clubId:
                settings.clubId,

                chatId:
                settings.chatId,

                ...data.pendingTemplate,

                enabled: true,
            });

        this.services.adminFlow.finish(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            renderTemplateCard(
                template,
            ),
            createTemplateKeyboard(
                template,
            ),
        );
    }

    private async confirmEdit(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        if (
            !data.templateId ||
            !data.pendingTemplate
        ) {
            this.services.adminFlow.finish(
                adminId,
            );

            await this.services.adminUi.replaceWithError(
                ctx,
                'Дані для редагування не знайдені. Відкрийте шаблон і спробуйте ще раз.',
                this.createBackToScheduleKeyboard(),
            );

            return;
        }

        const template =
            await this.templateScheduler.update(
                data.templateId,
                data.pendingTemplate,
            );

        this.services.adminFlow.finish(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            renderTemplateCard(
                template,
            ),
            createTemplateKeyboard(
                template,
            ),
        );
    }

    private async cancel(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        this.services.adminFlow.finish(
            adminId,
        );

        await this.services.adminUi.show(
            ctx,
            [
                '❌ Дію скасовано',
                '',
                'Зміни не були збережені',
            ].join('\n'),
            this.createBackToScheduleKeyboard(),
        );
    }

    private async showFormatError(
        ctx: Context,
        adminId: number,
        mode: TemplateFlowMode,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        const backCallback =
            mode === 'edit' &&
            data.templateId
                ? `${AdminCallbacks.TemplatePrefix}${data.templateId}`
                : AdminCallbacks.Schedule;

        await this.services.adminUi.replaceWithError(
            ctx,
            [
                'Не вдалося розпізнати формат',
                '',
                'Надішліть дані так:',
                '',
                'Назва: Вечірні тренування',
                'Ср 19:30-21:30',
                'Пт 18:00-20:00',
                '20',
                '8',
                '12:00',
                '',
                'Публікація буде за день до кожного тренування.',
            ].join('\n'),
            createFlowCancelKeyboard(
                backCallback,
            ),
        );
    }

    private parseTemplateInput(
        value: string,
    ): PendingTemplate | undefined {
        const lines =
            value
                .split('\n')
                .map(
                    line =>
                        line.trim(),
                )
                .filter(Boolean);

        let title:
            | string
            | undefined;

        let dataLines =
            lines;

        if (
            /^назва\s*:/i.test(
                lines[0] ?? '',
            )
        ) {
            title =
                lines[0]
                    .replace(
                        /^назва\s*:/i,
                        '',
                    )
                    .trim();

            if (!title) {
                return undefined;
            }

            dataLines =
                lines.slice(1);
        }

        if (
            dataLines.length < 4
        ) {
            return undefined;
        }

        const publishTime =
            this.normalizeTime(
                dataLines[
                dataLines.length - 1
                    ],
            );

        const minPlayers =
            Number(
                dataLines[
                dataLines.length - 2
                    ],
            );

        const placesLimit =
            Number(
                dataLines[
                dataLines.length - 3
                    ],
            );

        const slotLines =
            dataLines.slice(
                0,
                -3,
            );

        if (
            !this.isValidTime(
                publishTime,
            ) ||
            !Number.isInteger(
                placesLimit,
            ) ||
            placesLimit < 1 ||
            !Number.isInteger(
                minPlayers,
            ) ||
            minPlayers < 0 ||
            minPlayers >
            placesLimit ||
            slotLines.length === 0
        ) {
            return undefined;
        }

        const slots:
            CreateTrainingTemplateSlotInput[] =
            [];

        for (
            const line
            of slotLines
            ) {
            const match =
                line.match(
                    /^(\S+)\s+(\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2})$/,
                );

            if (!match) {
                return undefined;
            }

            const dayOfWeek =
                this.parseDay(
                    match[1],
                );

            const timeRange =
                this.parseTimeRange(
                    match[2],
                );

            if (
                !dayOfWeek ||
                !timeRange
            ) {
                return undefined;
            }

            slots.push({
                dayOfWeek,

                startTime:
                timeRange.startTime,

                endTime:
                timeRange.endTime,

                placesLimit,
                minPlayers,

                publishDaysBefore:
                    1,

                publishTime,

                enabled:
                    true,
            });
        }

        const firstSlot =
            slots[0];

        return {
            title:
                title ??
                `Тренування ${this.getShortDayTitle(
                    firstSlot.dayOfWeek,
                )} ${firstSlot.startTime}`,

            placesLimit,
            minPlayers,

            publishDaysBefore:
                1,

            publishTime,

            slots,
        };
    }

    private parseDay(
        value: string,
    ): number | undefined {
        const normalized =
            value
                .trim()
                .toLowerCase()
                .replace('.', '');

        return DAY_ALIASES[
            normalized
            ];
    }

    private parseTimeRange(
        value: string,
    ):
        | {
        startTime: string;
        endTime: string;
    }
        | undefined {
        const match =
            value.match(
                /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/,
            );

        if (!match) {
            return undefined;
        }

        const startTime =
            this.normalizeTime(
                match[1],
            );

        const endTime =
            this.normalizeTime(
                match[2],
            );

        if (
            !this.isValidTime(
                startTime,
            ) ||
            !this.isValidTime(
                endTime,
            ) ||
            this.timeToMinutes(
                endTime,
            ) <=
            this.timeToMinutes(
                startTime,
            )
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
        const [
            hours,
            minutes,
        ] =
            value.split(':');

        return `${hours.padStart(
            2,
            '0',
        )}:${minutes}`;
    }

    private isValidTime(
        value: string,
    ): boolean {
        if (
            !/^\d{2}:\d{2}$/.test(
                value,
            )
        ) {
            return false;
        }

        const [
            hours,
            minutes,
        ] =
            value
                .split(':')
                .map(Number);

        return (
            Number.isInteger(
                hours,
            ) &&
            Number.isInteger(
                minutes,
            ) &&
            hours >= 0 &&
            hours <= 23 &&
            minutes >= 0 &&
            minutes <= 59
        );
    }

    private timeToMinutes(
        value: string,
    ): number {
        const [
            hours,
            minutes,
        ] =
            value
                .split(':')
                .map(Number);

        return (
            hours * 60 +
            minutes
        );
    }

    private renderPreview(
        template: PendingTemplate,
    ): string {
        if (
            !template.slots.length
        ) {
            return 'У шаблоні немає слотів';
        }

        return [
            '👀 Перевірте дані',
            '',
            `🏸 ${template.title}`,
            '',
            ...template.slots.flatMap(
                slot => [
                    `📅 ${formatDay(
                        slot.dayOfWeek,
                    )}`,
                    `🕐 ${slot.startTime}–${slot.endTime}`,
                ],
            ),
            '',
            `👥 Місць: ${template.placesLimit}`,
            `🔻 Мінімум: ${template.minPlayers}`,
            '',
            '📣 Публікація за день до кожного тренування',
            `🕐 ${template.publishTime}`,
        ].join('\n');
    }

    private getShortDayTitle(
        day: number,
    ): string {
        const titles: Record<
            number,
            string
        > = {
            1: 'Пн',
            2: 'Вт',
            3: 'Ср',
            4: 'Чт',
            5: 'Пт',
            6: 'Сб',
            7: 'Нд',
        };

        return (
            titles[day] ??
            String(day)
        );
    }

    private createBackToScheduleKeyboard() {
        return Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📅 До розкладу',
                    AdminCallbacks.Schedule,
                ),
            ],
            [
                Markup.button.callback(
                    '🏠 Головне меню',
                    AdminCallbacks.MainMenu,
                ),
            ],
        ]);
    }
}