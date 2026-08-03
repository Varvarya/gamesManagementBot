import {
    Context,
    Markup,
} from 'telegraf';

import { ServicesContext } from '../../../app/services.context';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { UpdateTrainingTemplateSlotInput } from '../../../domain/templates/template.types';

import { AdminCallbacks } from '../callbacks/admin-callbacks';

import { createFlowCancelKeyboard } from '../keyboards/flow.keyboard';
import {
    createTemplateKeyboard,
    createTemplateChatSelectionKeyboard,
    createNoTemplateChatsKeyboard,
    createTemplatePreviewKeyboard,
} from '../keyboards/template.keyboard';

import {
    formatDay,
    renderTemplateCard,
} from '../ui/admin-formatters';

import { AdminFlowState, PendingTemplate } from './admin-flow.types';

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
    readonly textStates: readonly AdminFlowState[] = ['waiting_template_quick_input', 'waiting_template_edit_input'];
    readonly callbackStates: readonly AdminFlowState[] = ['waiting_template_chat_selection'];
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
            callback === AdminCallbacks.SelectTemplateChat ||
            callback === AdminCallbacks.BackFromTemplateChat ||
            callback === AdminCallbacks.BackFromTemplatePreview ||
            callback.startsWith(
                AdminCallbacks.TemplateChatPrefix,
            ) ||
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
            callback === AdminCallbacks.SelectTemplateChat
        ) {
            await this.showChatSelection(
                ctx,
                adminId,
                this.getMode(adminId),
            );
            return;
        }

        if (
            callback === AdminCallbacks.BackFromTemplateChat
        ) {
            await this.backFromChatSelection(
                ctx,
                adminId,
            );
            return;
        }

        if (callback === AdminCallbacks.BackFromTemplatePreview) {
            const mode = this.getMode(adminId);
            this.services.adminFlow.transition(adminId, mode === 'edit' ? 'waiting_template_edit_input' : 'waiting_template_quick_input');
            await this.services.adminUi.show(ctx, [mode === 'edit' ? '✏️ Редагування шаблону' : '➕ Новий шаблон', '', 'Надішліть виправлені дані ще раз. Попередньо введені дані збережено.'].join('\n'), createFlowCancelKeyboard(mode === 'edit' ? AdminCallbacks.CancelEditTemplate : AdminCallbacks.CancelCreateTemplate));
            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateChatPrefix,
            )
        ) {
            await this.selectChat(
                ctx,
                adminId,
                callback,
            );
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

        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        const pendingWithCurrentChat: PendingTemplate = {
            ...pendingTemplate,
            chatId:
                mode === 'edit'
                    ? data.templateChatId
                    : undefined,
        };

        this.services.adminFlow.setData(
            adminId,
            {
                pendingTemplate:
                    pendingWithCurrentChat,
            },
        );

        if (
            mode === 'edit' &&
            await this.getEnabledChat(
                pendingWithCurrentChat.chatId,
            )
        ) {
            await this.showPreview(
                ctx,
                adminId,
                pendingWithCurrentChat,
            );
        } else {
            await this.showChatSelection(
                ctx,
                adminId,
                mode,
            );
        }
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
                '1',
                '12:00',
                '',
                'Формат:',
                '1. Назва — необовʼязково',
                '2. Один або кілька рядків: день і час тренування',
                '3. Кількість місць',
                '4. Мінімум гравців',
                '5. За скільки днів публікувати',
                '6. Час публікації',
            ].join('\n'),
            createFlowCancelKeyboard(
                AdminCallbacks.CancelCreateTemplate,
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
                templateChatId:
                    template.chatId,
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
                String(
                    template.publishDaysBefore,
                ),
                template.publishTime,
            ].join('\n'),
            createFlowCancelKeyboard(
                AdminCallbacks.CancelEditTemplate,
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
            await this.services.adminUi.replaceWithError(
                ctx,
                'Дані шаблону не знайдені. Почніть створення ще раз.',
                this.createBackToScheduleKeyboard(),
            );

            return;
        }

        const chatId =
            data.pendingTemplate.chatId;

        if (chatId === undefined) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'Оберіть чат для шаблону.',
                createTemplatePreviewKeyboard('create'),
            );

            return;
        }

        if (!await this.getEnabledChat(chatId)) {
            await this.showChatSelection(
                ctx,
                adminId,
                'create',
            );
            return;
        }

        const settings =
            await this.services.repositories.settings.get();

        let template;
        try {
            template = await this.templateScheduler.create({
                clubId:
                settings.clubId,

                ...data.pendingTemplate,

                chatId,

                enabled: true,
            });
        } catch (error) {
            await this.services.adminUi.replaceWithError(ctx, `${error instanceof Error ? error.message : 'Не вдалося створити шаблон.'}\n\nВиправте дані або виберіть інший чат.`, createTemplatePreviewKeyboard('create'));
            return;
        }

        this.services.adminFlow.finish(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            `Шаблон створено.\n\n${renderTemplateCard(template)}`,
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
            await this.services.adminUi.replaceWithError(
                ctx,
                'Дані для редагування не знайдені. Відкрийте шаблон і спробуйте ще раз.',
                this.createBackToScheduleKeyboard(),
            );

            return;
        }

        const chatId =
            data.pendingTemplate.chatId;

        if (chatId === undefined) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'Оберіть чат для шаблону.',
                createTemplatePreviewKeyboard('edit'),
            );
            return;
        }

        if (!await this.getEnabledChat(chatId)) {
            await this.showChatSelection(
                ctx,
                adminId,
                'edit',
            );
            return;
        }

        let template;
        try {
            template = await this.templateScheduler.update(
                data.templateId,
                {
                    ...data.pendingTemplate,
                    chatId,
                },
            );
        } catch (error) {
            await this.services.adminUi.replaceWithError(ctx, `${error instanceof Error ? error.message : 'Не вдалося оновити шаблон.'}\n\nВиправте дані або виберіть інший чат.`, createTemplatePreviewKeyboard('edit'));
            return;
        }

        this.services.adminFlow.finish(
            adminId,
        );

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            `Зміни шаблону збережено.\n\n${renderTemplateCard(template)}`,
            createTemplateKeyboard(
                template,
            ),
        );
    }

    private async showChatSelection(
        ctx: Context,
        adminId: number,
        mode: TemplateFlowMode,
    ): Promise<void> {
        const chats =
            await this.services.chats.getEnabled();

        if (!chats.length) {
            await this.services.adminUi.replaceWithError(
                ctx,
                [
                    'Немає жодного увімкненого чату.',
                    '',
                    'Додайте або увімкніть чат у розділі «💬 Чати», потім поверніться до цього шаблону.',
                ].join('\n'),
                createNoTemplateChatsKeyboard(
                    mode,
                ),
            );
            return;
        }

        this.services.adminFlow.transition(
            adminId,
            'waiting_template_chat_selection',
        );

        await this.services.adminUi.show(
            ctx,
            '💬 Оберіть чат для публікації тренувань:',
            createTemplateChatSelectionKeyboard(
                chats,
                mode,
            ),
        );
    }

    private async selectChat(
        ctx: Context,
        adminId: number,
        callback: string,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        const chatId = Number(
            callback.slice(
                AdminCallbacks.TemplateChatPrefix.length,
            ),
        );

        const chats =
            await this.services.chats.getEnabled();

        const chat = chats.find(
            item => item.id === chatId,
        );

        if (!data.pendingTemplate || !chat) {
            await this.services.adminUi.replaceWithError(
                ctx,
                'Цей чат більше недоступний. Оберіть інший увімкнений чат.',
                chats.length
                    ? createTemplateChatSelectionKeyboard(
                        chats,
                        this.getMode(adminId),
                    )
                    : createNoTemplateChatsKeyboard(
                        this.getMode(adminId),
                    ),
            );
            return;
        }

        const pendingTemplate: PendingTemplate = {
            ...data.pendingTemplate,
            chatId,
        };

        this.services.adminFlow.setData(
            adminId,
            {
                pendingTemplate,
            },
        );

        await this.showPreview(
            ctx,
            adminId,
            pendingTemplate,
        );
    }

    private async showPreview(
        ctx: Context,
        adminId: number,
        pendingTemplate: PendingTemplate,
    ): Promise<void> {
        const chat = await this.getEnabledChat(
            pendingTemplate.chatId,
        );

        if (!chat) {
            await this.showChatSelection(
                ctx,
                adminId,
                this.getMode(adminId),
            );
            return;
        }

        await this.services.adminUi.show(
            ctx,
            [
                this.renderPreview(pendingTemplate),
                '',
                `💬 Чат: ${chat.name}`,
            ].join('\n'),
            createTemplatePreviewKeyboard(
                this.getMode(adminId),
            ),
        );
    }

    private async backFromChatSelection(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(adminId);
        const mode = this.getMode(adminId);

        if (
            data.pendingTemplate?.chatId !== undefined &&
            await this.getEnabledChat(
                data.pendingTemplate.chatId,
            )
        ) {
            await this.showPreview(
                ctx,
                adminId,
                data.pendingTemplate,
            );
            return;
        }

        this.services.adminFlow.transition(
            adminId,
            mode === 'edit'
                ? 'waiting_template_edit_input'
                : 'waiting_template_quick_input',
        );

        await this.services.adminUi.show(
            ctx,
            mode === 'edit'
                ? '✏️ Надішліть оновлені дані шаблону ще раз.'
                : '➕ Надішліть дані нового шаблону ще раз.',
            createFlowCancelKeyboard(
                mode === 'edit'
                    ? AdminCallbacks.CancelEditTemplate
                    : AdminCallbacks.CancelCreateTemplate,
            ),
        );
    }

    private async getEnabledChat(
        chatId: number | undefined,
    ) {
        if (chatId === undefined) {
            return undefined;
        }

        const chat =
            await this.services.chats.getById(chatId);

        return chat?.enabled
            ? chat
            : undefined;
    }

    private getMode(
        adminId: number,
    ): TemplateFlowMode {
        return this.services.adminFlow.getData(
            adminId,
        ).templateId
            ? 'edit'
            : 'create';
    }

    private async cancel(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        this.services.adminFlow.finish(
            adminId,
        );

        if (data.templateId) {
            const template =
                await this.services.templates.getRequired(
                    data.templateId,
                );

            await this.services.adminUi.show(
                ctx,
                renderTemplateCard(template),
                createTemplateKeyboard(template),
            );
            return;
        }

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
            mode === 'edit'
                ? AdminCallbacks.CancelEditTemplate
                : AdminCallbacks.CancelCreateTemplate;

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
                '1',
                '12:00',
                '',
                'Останні два рядки: днів до публікації та час.',
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
            dataLines.length < 5
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
                dataLines.length - 3
                    ],
            );

        const publishDaysBefore = Number(dataLines[dataLines.length - 2]);

        const placesLimit =
            Number(
                dataLines[
                dataLines.length - 4
                    ],
            );

        const slotLines =
            dataLines.slice(
                0,
                -4,
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
            !Number.isInteger(publishDaysBefore) ||
            publishDaysBefore < 0 ||
            slotLines.length === 0
        ) {
            return undefined;
        }

        const slots:
            UpdateTrainingTemplateSlotInput[] =
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
                    publishDaysBefore,

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
                publishDaysBefore,

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
            `📣 Публікація за ${template.publishDaysBefore} дн. до тренування`,
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
