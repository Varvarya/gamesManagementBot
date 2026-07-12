import {Context, Markup} from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { TemplateSchedulerService } from '../../domain/templates/template-scheduler.service';
import {
    PendingTemplate,
} from '../admin/admin-flow.types';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../admin/callbacks/admin-callbacks';
import {
    createTemplatePreviewKeyboard, createTrainingPlayerSearchKeyboard,
} from '../admin/keyboards/admin.keyboard';

const DAYS = [
    { value: 1, title: 'Пн' },
    { value: 2, title: 'Вт' },
    { value: 3, title: 'Ср' },
    { value: 4, title: 'Чт' },
    { value: 5, title: 'Пт' },
    { value: 6, title: 'Сб' },
    { value: 7, title: 'Нд' },
];

export class AdminFlowHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly templateScheduler: TemplateSchedulerService,
        private readonly trainingPublisher: TrainingPublisherService,
    ) {}

    async handleText(ctx: Context): Promise<void> {
        if (
            ctx.chat?.type !== 'private' ||
            !ctx.from ||
            !ctx.message ||
            !('text' in ctx.message)
        ) {
            return;
        }

        const adminId = ctx.from.id;

        if (!(await this.isAdmin(adminId))) {
            return;
        }

        const state =
            this.services.adminFlow.getState(adminId);

        const text = ctx.message.text.trim();

        switch (state) {
            case 'waiting_template_quick_input':
                await this.handleTemplateQuickInput(
                    ctx,
                    adminId,
                    text,
                );
                return;

            case 'waiting_player_name':
                await this.handlePlayerName(
                    ctx,
                    adminId,
                    text,
                );
                return;

            case 'waiting_new_player_name':
                await this.handleNewPlayerName(
                    ctx,
                    adminId,
                    text,
                );
                return;

            case 'waiting_config_import':
                // Реалізуємо наступним кроком.
                return;

            case 'waiting_template_edit_input':
                await this.handleTemplateEditInput(
                    ctx,
                    adminId,
                    text,
                );
                return;

            case 'waiting_training_add_player':
                await this.handleTrainingPlayerSearch(
                    ctx,
                    adminId,
                    text,
                    'add',
                );
                return;

            case 'waiting_training_remove_player':
                await this.handleTrainingPlayerSearch(
                    ctx,
                    adminId,
                    text,
                    'remove',
                );
                return;

            default:
                return;
        }
    }

    async handleCallback(
        ctx: Context,
    ): Promise<boolean> {
        if (
            ctx.chat?.type !== 'private' ||
            !ctx.from ||
            !ctx.callbackQuery ||
            !('data' in ctx.callbackQuery)
        ) {
            return false;
        }


        const adminId = ctx.from.id;

        if (!(await this.isAdmin(adminId))) {
            return false;
        }

        const callback = ctx.callbackQuery.data;

        if (
            callback ===
            AdminCallbacks.ConfirmCreateTemplate
        ) {
            await ctx.answerCbQuery();

            await this.confirmTemplateCreation(
                ctx,
                adminId,
            );

            return true;
        }

        if (
            callback ===
            AdminCallbacks.CancelCreateTemplate
        ) {
            await ctx.answerCbQuery();

            this.services.adminFlow.reset(adminId);

            await ctx.editMessageText(
                '❌ Створення шаблону скасовано',
            );

            return true;
        }

        if (
            callback.startsWith(
                AdminCallbacks.EditTemplatePrefix,
            )
        ) {
            await ctx.answerCbQuery();

            const templateId = callback.replace(
                AdminCallbacks.EditTemplatePrefix,
                '',
            );

            await this.startTemplateEditing(
                ctx,
                adminId,
                templateId,
            );

            return true;
        }

        if (
            callback ===
            AdminCallbacks.ConfirmEditTemplate
        ) {
            await ctx.answerCbQuery();

            await this.confirmTemplateEditing(
                ctx,
                adminId,
            );

            return true;
        }

        if (
            callback ===
            AdminCallbacks.CancelEditTemplate
        ) {
            await ctx.answerCbQuery();

            this.services.adminFlow.reset(adminId);

            await ctx.editMessageText(
                '❌ Редагування скасовано',
            );

            return true;
        }

        return false;
    }

    async startTemplateCreation(
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
                'Формат:',
                'Назва: ... — необовʼязково',
                '1. День тренування',
                '2. Час початку-завершення',
                '3. Кількість місць',
                '4. Мінімум гравців',
                '5. День і час публікації',
            ].join('\n'),
        );
    }

    private async handleTemplateQuickInput(
        ctx: Context,
        adminId: number,
        text: string,
    ): Promise<void> {
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

        await ctx.reply(
            this.renderTemplatePreview(
                pendingTemplate,
            ),
            createTemplatePreviewKeyboard(),
        );
    }

    private async confirmTemplateCreation(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(adminId);

        const pendingTemplate =
            data.pendingTemplate;

        if (!pendingTemplate) {
            throw new Error(
                'Pending template not found',
            );
        }

        const settings =
            await this.services.repositories.settings.get();

        if (!settings.chatId) {
            throw new Error(
                'Club chatId is not configured',
            );
        }

        const template =
            await this.templateScheduler.create({
                clubId: settings.clubId,
                chatId: settings.chatId,

                title: pendingTemplate.title,

                dayOfWeek:
                pendingTemplate.dayOfWeek,

                startTime:
                pendingTemplate.startTime,

                endTime:
                pendingTemplate.endTime,

                placesLimit:
                pendingTemplate.placesLimit,

                minPlayers:
                pendingTemplate.minPlayers,

                publishDayOfWeek:
                pendingTemplate.publishDayOfWeek,

                publishTime:
                pendingTemplate.publishTime,

                enabled: true,
            });

        this.services.adminFlow.reset(adminId);

        await ctx.editMessageText(
            [
                '✅ Шаблон створено',
                '',
                `🏸 ${template.title}`,
                `📅 ${this.getDayTitle(template.dayOfWeek)}`,
                `🕐 ${template.startTime}–${template.endTime}`,
                `👥 ${template.placesLimit} місць`,
                `🔻 Мінімум: ${template.minPlayers}`,
                '',
                `📣 ${this.getDayTitle(template.publishDayOfWeek)} ${template.publishTime}`,
            ].join('\n'),
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

        const firstLine = lines[0];

        if (/^назва\s*:/i.test(firstLine ?? '')) {
            title = firstLine
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

            publishTime:
            publish.time,
        };
    }

    private parsePublishValue(
        value: string,
    ): {
        dayOfWeek: number;
        time: string;
    } | undefined {
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
        const normalized =
            value
                .trim()
                .toLowerCase()
                .replace('.', '');

        const aliases: Record<string, number> = {
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

        return aliases[normalized];
    }

    private parseTimeRange(
        value: string,
    ): {
        startTime: string;
        endTime: string;
    } | undefined {
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
        time: string,
    ): string {
        const [hours, minutes] =
            time.split(':');

        return `${hours.padStart(2, '0')}:${minutes}`;
    }

    private isValidTime(
        time: string,
    ): boolean {
        if (!/^\d{2}:\d{2}$/.test(time)) {
            return false;
        }

        const [hours, minutes] =
            time.split(':').map(Number);

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
        time: string,
    ): number {
        const [hours, minutes] =
            time.split(':').map(Number);

        return hours * 60 + minutes;
    }

    private renderTemplatePreview(
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
        return (
            DAYS.find(
                (item) => item.value === day,
            )?.title ?? String(day)
        );
    }

    private async isAdmin(
        telegramUserId: number,
    ): Promise<boolean> {
        const settings =
            await this.services.repositories.settings.get();

        return settings.admins.some(
            (admin) =>
                admin.telegramUserId ===
                telegramUserId,
        );
    }

    private async startTemplateEditing(
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
                'Надішліть оновлені дані одним повідомленням',
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

    private async handleTemplateEditInput(
        ctx: Context,
        adminId: number,
        text: string,
    ): Promise<void> {
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

        await ctx.reply(
            this.renderTemplatePreview(
                pendingTemplate,
            ),
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '✅ Зберегти зміни',
                        AdminCallbacks.ConfirmEditTemplate,
                    ),
                ],
                [
                    Markup.button.callback(
                        '❌ Скасувати',
                        AdminCallbacks.CancelEditTemplate,
                    ),
                ],
            ]),
        );
    }

    private async confirmTemplateEditing(
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

        const template =
            await this.templateScheduler.update(
                data.templateId,
                {
                    title:
                    data.pendingTemplate.title,

                    dayOfWeek:
                    data.pendingTemplate.dayOfWeek,

                    startTime:
                    data.pendingTemplate.startTime,

                    endTime:
                    data.pendingTemplate.endTime,

                    placesLimit:
                    data.pendingTemplate.placesLimit,

                    minPlayers:
                    data.pendingTemplate.minPlayers,

                    publishDayOfWeek:
                    data.pendingTemplate.publishDayOfWeek,

                    publishTime:
                    data.pendingTemplate.publishTime,
                },
            );

        this.services.adminFlow.reset(adminId);

        await ctx.editMessageText(
            [
                '✅ Шаблон оновлено',
                '',
                `🏸 ${template.title}`,
                `📅 ${this.getDayTitle(template.dayOfWeek)}`,
                `🕐 ${template.startTime}–${template.endTime}`,
                `👥 ${template.placesLimit} місць`,
                `🔻 Мінімум: ${template.minPlayers}`,
                '',
                `📣 ${this.getDayTitle(template.publishDayOfWeek)} ${template.publishTime}`,
            ].join('\n'),
        );
    }

    private async handlePlayerName(
        ctx: Context,
        adminId: number,
        name: string,
    ): Promise<void> {
        const normalizedName = name
            .trim()
            .replace(/\s+/g, ' ');

        if (
            normalizedName.length < 2 ||
            normalizedName.length > 100
        ) {
            await ctx.reply(
                '❌ Введіть коректне імʼя',
            );

            return;
        }

        const data =
            this.services.adminFlow.getData(adminId);

        if (!data.playerId) {
            throw new Error(
                'Player ID is missing from admin flow',
            );
        }

        const player =
            await this.services.players.updateName(
                data.playerId,
                normalizedName,
            );

        this.services.adminFlow.reset(adminId);

        await ctx.reply(
            [
                '✅ Гравця оновлено',
                '',
                `👤 ${player.displayName}`,
            ].join('\n'),
        );
    }

    private async handleTrainingPlayerSearch(
        ctx: Context,
        adminId: number,
        query: string,
        action: 'add' | 'remove',
    ): Promise<void> {
        const data =
            this.services.adminFlow.getData(adminId);

        if (!data.trainingId) {
            throw new Error(
                'Training ID is missing from admin flow',
            );
        }

        let players =
            await this.services.repositories.players.searchByName(
                query,
            );

        if (action === 'remove') {
            const training =
                await this.services.trainings.getRequired(
                    data.trainingId,
                );

            const playerIds = new Set([
                ...training.participants.map(
                    (participant) =>
                        participant.playerId,
                ),
                ...training.waitlist.map(
                    (participant) =>
                        participant.playerId,
                ),
            ]);

            players = players.filter(
                (player) =>
                    playerIds.has(player.id),
            );
        } else {
            players = players.filter(
                (player) => player.isActive,
            );
        }

        if (players.length === 0) {
            await ctx.reply(
                '❌ Гравців не знайдено',
            );

            return;
        }

        if (players.length === 1) {
            const player = players[0];

            if (action === 'add') {
                const training =
                    await this.services.trainingParticipants.addOrUpdateParticipant({
                        trainingId: data.trainingId,
                        playerId: player.id,
                        telegramUserId:
                        player.telegramUserId,
                        places: 1,
                        source: 'admin',
                    });

                await this.trainingPublisher.refreshMessage(
                    training.id,
                );

                this.services.adminFlow.reset(
                    adminId,
                );

                await ctx.reply(
                    `✅ ${player.displayName} додано`,
                );

                return;
            }

            const training =
                await this.services.trainingParticipants.removeParticipantCompletely({
                    trainingId: data.trainingId,
                    playerId: player.id,
                });

            await this.trainingPublisher.refreshMessage(
                training.id,
            );

            this.services.adminFlow.reset(
                adminId,
            );

            await ctx.reply(
                `✅ ${player.displayName} прибрано`,
            );

            return;
        }

        await ctx.reply(
            'Оберіть гравця',
            createTrainingPlayerSearchKeyboard(
                data.trainingId,
                players.slice(0, 20),
                action,
            ),
        );
    }

    private async handleNewPlayerName(
        ctx: Context,
        adminId: number,
        name: string,
    ): Promise<void> {
        try {
            const player =
                await this.services.players.createManual(
                    name,
                );

            this.services.adminFlow.reset(
                adminId,
            );

            await ctx.reply(
                [
                    '✅ Гравця створено',
                    '',
                    `👤 ${player.displayName}`,
                ].join('\n'),
            );
        } catch (error) {
            await ctx.reply(
                [
                    '❌ Не вдалося створити гравця',
                    '',
                    error instanceof Error
                        ? error.message
                        : 'Unknown error',
                ].join('\n'),
            );
        }
    }
}