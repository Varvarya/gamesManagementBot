import { Context, Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { ServicesContext } from '../../../app/services.context';
import { TemplateSchedulerService } from '../../../domain/templates/template-scheduler.service';
import { TrainingTemplate } from '../../../domain/templates/template.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { Training } from '../../../domain/trainings/training.types';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import {
    createAdminMainKeyboard,
    createBackKeyboard,
    createScheduleKeyboard,
    createTemplateDeleteConfirmationKeyboard,
    createTemplateKeyboard,
    createActiveTrainingsKeyboard,
    createTrainingCancelConfirmationKeyboard,
    createTrainingKeyboard,
    createPlayerListKeyboard,
    createPlayerKeyboard,
    createPlayersKeyboard,
    createTrainingPlayerSearchKeyboard,
} from '../keyboards/admin.keyboard';
import { Player } from '../../../domain/players/player.types';

const DAYS = [
    { value: 1, title: 'Пн' },
    { value: 2, title: 'Вт' },
    { value: 3, title: 'Ср' },
    { value: 4, title: 'Чт' },
    { value: 5, title: 'Пт' },
    { value: 6, title: 'Сб' },
    { value: 7, title: 'Нд' },
];

export class AdminMenuHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly templateScheduler: TemplateSchedulerService,
        private readonly trainingPublisher: TrainingPublisherService,
    ) {}

    async showMain(ctx: Context): Promise<void> {
        const adminId = this.getAdminId(ctx);

        if (!adminId || !(await this.isAdmin(adminId))) {
            return;
        }

        this.services.adminFlow.reset(adminId);

        const settings =
            await this.services.repositories.settings.get();

        const activeTrainings =
            await this.services.repositories.trainings.listActive();

        const unconfirmedPlayers =
            await this.services.repositories.players.listUnconfirmed();

        const text = [
            `🏸 ${settings.title}`,
            '',
            `🟢 Активних тренувань: ${activeTrainings.length}`,
            `⚠️ Непідтверджених гравців: ${unconfirmedPlayers.length}`,
        ].join('\n');

        await this.replyOrEdit(
            ctx,
            text,
            createAdminMainKeyboard(),
        );
    }

    async handleCallback(ctx: Context): Promise<void> {
        if (
            !ctx.callbackQuery ||
            !('data' in ctx.callbackQuery)
        ) {
            return;
        }

        const adminId = this.getAdminId(ctx);

        if (!adminId || !(await this.isAdmin(adminId))) {
            return;
        }

        const callback = ctx.callbackQuery.data;

        await ctx.answerCbQuery();

        if (callback === AdminCallbacks.CreatePlayer) {
            await this.startPlayerCreation(
                ctx,
                adminId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingCancelConfirmPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingCancelConfirmPrefix,
                '',
            );

            await this.cancelTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingCancelPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingCancelPrefix,
                '',
            );

            await this.confirmTrainingCancel(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingRefreshPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingRefreshPrefix,
                '',
            );

            await this.refreshTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingClosePrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingClosePrefix,
                '',
            );

            await this.closeTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingOpenPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingOpenPrefix,
                '',
            );

            await this.openTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.PlayerPrefix,
            )
        ) {
            const value = callback.replace(
                AdminCallbacks.PlayerPrefix,
                '',
            );

            if (value.endsWith(':rename')) {
                const playerId = value.replace(
                    ':rename',
                    '',
                );

                await this.startPlayerRename(
                    ctx,
                    adminId,
                    playerId,
                );

                return;
            }

            await this.showPlayer(
                ctx,
                value,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingSelectAddPlayerPrefix,
            )
        ) {
            const value = callback.replace(
                AdminCallbacks.TrainingSelectAddPlayerPrefix,
                '',
            );

            const [trainingId, playerId] = value.split(':');

            await this.addPlayerToTraining(
                ctx,
                trainingId,
                playerId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingSelectRemovePlayerPrefix,
            )
        ) {
            const value = callback.replace(
                AdminCallbacks.TrainingSelectRemovePlayerPrefix,
                '',
            );

            const [trainingId, playerId] = value.split(':');

            await this.removePlayerFromTraining(
                ctx,
                trainingId,
                playerId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingAddPlayerPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingAddPlayerPrefix,
                '',
            );

            await this.startAddPlayerToTraining(
                ctx,
                adminId,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingRemovePlayerPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingRemovePlayerPrefix,
                '',
            );

            await this.startRemovePlayerFromTraining(
                ctx,
                adminId,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TrainingPrefix,
            )
        ) {
            const trainingId = callback.replace(
                AdminCallbacks.TrainingPrefix,
                '',
            );

            await this.showTraining(
                ctx,
                trainingId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplateDeleteConfirmPrefix,
            )
        ) {
            const templateId = callback.replace(
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
            const templateId = callback.replace(
                AdminCallbacks.TemplateDeletePrefix,
                '',
            );

            await this.confirmTemplateDelete(
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
            const templateId = callback.replace(
                AdminCallbacks.TemplateTogglePrefix,
                '',
            );

            await this.toggleTemplate(
                ctx,
                templateId,
            );

            return;
        }

        if (
            callback.startsWith(
                AdminCallbacks.TemplatePrefix,
            )
        ) {
            const templateId = callback.replace(
                AdminCallbacks.TemplatePrefix,
                '',
            );

            await this.showTemplate(
                ctx,
                templateId,
            );

            return;
        }

        switch (callback) {
            case AdminCallbacks.MainMenu:
                await this.showMain(ctx);
                return;

            case AdminCallbacks.Schedule:
                await this.showSchedule(ctx);
                return;

            case AdminCallbacks.ActiveTrainings:
                await this.showActiveTrainings(ctx);
                return;

            case AdminCallbacks.Players:
                await this.showPlayers(ctx);
                return;

            case AdminCallbacks.UnconfirmedPlayers:
                await this.showUnconfirmedPlayers(ctx);
                return;

            case AdminCallbacks.AllPlayers:
                await this.showAllPlayers(ctx);
                return;

            case AdminCallbacks.Settings:
                await this.showPlaceholder(
                    ctx,
                    '⚙️ Налаштування',
                );
                return;

            case AdminCallbacks.CreateTemplate:
                return;
        }
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

        const text = [
            '📅 Розклад',
            '',
            templates.length === 0
                ? 'Шаблонів поки немає'
                : `Шаблонів: ${templates.length}`,
        ].join('\n');

        await this.replyOrEdit(
            ctx,
            text,
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

        await this.replyOrEdit(
            ctx,
            this.renderTemplate(template),
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
                template.id,
            )
            : await this.templateScheduler.enable(
                template.id,
            );

        await this.replyOrEdit(
            ctx,
            this.renderTemplate(updated),
            createTemplateKeyboard(updated),
        );
    }

    private async confirmTemplateDelete(
        ctx: Context,
        templateId: string,
    ): Promise<void> {
        const template =
            await this.services.templates.getRequired(
                templateId,
            );

        await this.replyOrEdit(
            ctx,
            [
                '🗑 Видалити шаблон?',
                '',
                `🏸 ${template.title}`,
                `📅 ${this.getDayTitle(template.dayOfWeek)}`,
                `🕐 ${template.startTime}–${template.endTime}`,
                '',
                'Цю дію не можна скасувати',
            ].join('\n'),
            createTemplateDeleteConfirmationKeyboard(
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

    private renderTemplate(
        template: TrainingTemplate,
    ): string {
        return [
            `${template.enabled ? '🟢' : '⚪️'} ${template.title}`,
            '',
            `📅 День: ${this.getDayTitle(template.dayOfWeek)}`,
            `🕐 Час: ${template.startTime}–${template.endTime}`,
            template.location
                ? `📍 ${template.location}`
                : undefined,
            '',
            `👥 Місць: ${template.placesLimit}`,
            `🔻 Мінімум: ${template.minPlayers}`,
            '',
            `📣 Публікація: ${this.getDayTitle(template.publishDayOfWeek)} ${template.publishTime}`,
        ]
            .filter(
                (line): line is string =>
                    line !== undefined,
            )
            .join('\n');
    }

    private async showPlaceholder(
        ctx: Context,
        title: string,
    ): Promise<void> {
        await this.replyOrEdit(
            ctx,
            `${title}\n\nРозділ ще в розробці`,
            createBackKeyboard(),
        );
    }

    private getDayTitle(day: number): string {
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
                admin.telegramUserId === telegramUserId,
        );
    }

    private getAdminId(
        ctx: Context,
    ): number | undefined {
        if (ctx.chat?.type !== 'private') {
            return undefined;
        }

        return ctx.from?.id;
    }

    private async replyOrEdit(
        ctx: Context,
        text: string,
        extra: Markup.Markup<InlineKeyboardMarkup>,
    ): Promise<void> {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(
                text,
                extra
            );

            return;
        }

        await ctx.reply(
            text,
            extra,
        );
    }

    private async showActiveTrainings(
        ctx: Context,
    ): Promise<void> {
        const trainings =
            await this.services.repositories.trainings.listActive();

        const sorted = trainings.sort(
            (first, second) =>
                this.getTrainingTimestamp(first) -
                this.getTrainingTimestamp(second),
        );

        await this.replyOrEdit(
            ctx,
            [
                '🏸 Активні тренування',
                '',
                sorted.length === 0
                    ? 'Активних тренувань немає'
                    : `Тренувань: ${sorted.length}`,
            ].join('\n'),
            createActiveTrainingsKeyboard(sorted),
        );
    }

    private async showTraining(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        await this.replyOrEdit(
            ctx,
            this.renderTraining(training),
            createTrainingKeyboard(training),
        );
    }

    private async closeTraining(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.close(
                trainingId,
            );

        await this.trainingPublisher.refreshMessage(
            training.id,
        );

        await this.showTraining(
            ctx,
            training.id,
        );
    }

    private async openTraining(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.open(
                trainingId,
            );

        await this.trainingPublisher.refreshMessage(
            training.id,
        );

        await this.showTraining(
            ctx,
            training.id,
        );
    }

    private async refreshTraining(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        await this.trainingPublisher.refreshMessage(
            trainingId,
        );

        await ctx.answerCbQuery(
            'Повідомлення оновлено',
        );

        await this.showTraining(
            ctx,
            trainingId,
        );
    }

    private async confirmTrainingCancel(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        await this.replyOrEdit(
            ctx,
            [
                '❌ Скасувати тренування?',
                '',
                `🏸 ${training.title}`,
                `📅 ${training.date}`,
                `🕐 ${training.startTime}–${training.endTime}`,
            ].join('\n'),
            createTrainingCancelConfirmationKeyboard(
                training.id,
            ),
        );
    }

    private async cancelTraining(
        ctx: Context,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.cancel(
                trainingId,
            );

        await this.trainingPublisher.refreshMessage(
            training.id,
        );

        await this.showActiveTrainings(ctx);
    }

    private renderTraining(
        training: Training,
    ): string {
        const activePlaces =
            training.participants.reduce(
                (sum, participant) =>
                    sum + participant.places,
                0,
            );

        const waitingPlaces =
            training.waitlist.reduce(
                (sum, participant) =>
                    sum + participant.places,
                0,
            );

        return [
            `🏸 ${training.title}`,
            '',
            `📅 ${training.date}`,
            `🕐 ${training.startTime}–${training.endTime}`,
            training.location
                ? `📍 ${training.location}`
                : undefined,
            '',
            `Статус: ${this.getTrainingStatusTitle(training)}`,
            '',
            `👥 Записано: ${activePlaces}/${training.placesLimit}`,
            `🕒 Очікування: ${waitingPlaces}`,
            `🔻 Мінімум: ${training.minPlayers}`,
        ]
            .filter(
                (line): line is string =>
                    line !== undefined,
            )
            .join('\n');
    }

    private getTrainingStatusTitle(
        training: Training,
    ): string {
        switch (training.status) {
            case 'open':
                return '🟢 Запис відкрито';

            case 'closed':
                return '🔒 Запис закрито';

            case 'cancelled':
                return '❌ Скасовано';

            case 'finished':
                return '✅ Завершено';

            case 'draft':
                return '⚪️ Чернетка';
        }
    }

    private getTrainingTimestamp(
        training: Training,
    ): number {
        return new Date(
            `${training.date}T${training.startTime}:00`,
        ).getTime();
    }

    private async showPlayers(
        ctx: Context,
    ): Promise<void> {
        const unconfirmed =
            await this.services.repositories.players.listUnconfirmed();

        await this.replyOrEdit(
            ctx,
            [
                '👥 Гравці',
                '',
                `⚠️ Очікують підтвердження: ${unconfirmed.length}`,
            ].join('\n'),
            createPlayersKeyboard(
                unconfirmed.length,
            ),
        );
    }

    private async showUnconfirmedPlayers(
        ctx: Context,
    ): Promise<void> {
        const players =
            await this.services.repositories.players.listUnconfirmed();

        await this.replyOrEdit(
            ctx,
            [
                '⚠️ Непідтверджені гравці',
                '',
                players.length === 0
                    ? 'Усі гравці підтверджені'
                    : 'Оберіть гравця',
            ].join('\n'),
            createPlayerListKeyboard(players),
        );
    }

    private async showAllPlayers(
        ctx: Context,
    ): Promise<void> {
        const players =
            await this.services.repositories.players.list();

        const sorted = players.sort(
            (first, second) =>
                first.displayName.localeCompare(
                    second.displayName,
                    'uk',
                ),
        );

        await this.replyOrEdit(
            ctx,
            [
                '👥 Всі гравці',
                '',
                `Гравців: ${sorted.length}`,
            ].join('\n'),
            createPlayerListKeyboard(sorted),
        );
    }

    private async showPlayer(
        ctx: Context,
        playerId: string,
    ): Promise<void> {
        const player =
            await this.services.repositories.players.findById(
                playerId,
            );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        await this.replyOrEdit(
            ctx,
            this.renderPlayer(player),
            createPlayerKeyboard(player),
        );
    }

    private async startPlayerRename(
        ctx: Context,
        adminId: number,
        playerId: string,
    ): Promise<void> {
        const player =
            await this.services.repositories.players.findById(
                playerId,
            );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        this.services.adminFlow.transition(
            adminId,
            'waiting_player_name',
            {
                playerId,
            },
        );

        await ctx.editMessageText(
            [
                '✏️ Імʼя гравця',
                '',
                `Зараз: ${player.displayName}`,
                '',
                'Надішліть правильне імʼя одним повідомленням',
            ].join('\n'),
        );
    }

    private renderPlayer(
        player: Player,
    ): string {
        return [
            `${
                player.isConfirmed
                    ? '👤'
                    : '⚠️'
            } ${player.displayName}`,
            '',
            player.telegramName
                ? `Telegram name: ${player.telegramName}`
                : undefined,
            player.username
                ? `Telegram: @${player.username}`
                : 'Telegram username відсутній',
            '',
            player.isConfirmed
                ? '✅ Імʼя підтверджено'
                : '⚠️ Імʼя потрібно підтвердити',
        ]
            .filter(
                (line): line is string =>
                    line !== undefined,
            )
            .join('\n');
    }

    private async startAddPlayerToTraining(
        ctx: Context,
        adminId: number,
        trainingId: string,
    ): Promise<void> {
        await this.services.trainings.getRequired(
            trainingId,
        );

        this.services.adminFlow.transition(
            adminId,
            'waiting_training_add_player',
            {
                trainingId,
            },
        );

        await ctx.editMessageText(
            [
                '➕ Додати гравця',
                '',
                'Введіть імʼя або частину імені',
            ].join('\n'),
        );
    }

    private async startRemovePlayerFromTraining(
        ctx: Context,
        adminId: number,
        trainingId: string,
    ): Promise<void> {
        const training =
            await this.services.trainings.getRequired(
                trainingId,
            );

        if (
            training.participants.length === 0 &&
            training.waitlist.length === 0
        ) {
            await ctx.answerCbQuery(
                'Список порожній',
            );

            return;
        }

        this.services.adminFlow.transition(
            adminId,
            'waiting_training_remove_player',
            {
                trainingId,
            },
        );

        await ctx.editMessageText(
            [
                '➖ Прибрати гравця',
                '',
                'Введіть імʼя або частину імені',
            ].join('\n'),
        );
    }

    private async addPlayerToTraining(
        ctx: Context,
        trainingId: string,
        playerId: string,
    ): Promise<void> {
        const player =
            await this.services.repositories.players.findById(
                playerId,
            );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        const training =
            await this.services.trainingParticipants.addOrUpdateParticipant({
                trainingId,
                playerId: player.id,
                telegramUserId: player.telegramUserId,
                places: 1,
                source: 'admin',
            });

        await this.trainingPublisher.refreshMessage(
            training.id,
        );

        await this.showTraining(
            ctx,
            training.id,
        );
    }

    private async removePlayerFromTraining(
        ctx: Context,
        trainingId: string,
        playerId: string,
    ): Promise<void> {
        const training =
            await this.services.trainingParticipants.removeParticipantCompletely({
                trainingId,
                playerId,
            });

        await this.trainingPublisher.refreshMessage(
            training.id,
        );

        await this.showTraining(
            ctx,
            training.id,
        );
    }

    private async startPlayerCreation(
        ctx: Context,
        adminId: number,
    ): Promise<void> {
        this.services.adminFlow.transition(
            adminId,
            'waiting_new_player_name',
        );

        await ctx.editMessageText(
            [
                '➕ Новий гравець',
                '',
                'Введіть імʼя гравця',
            ].join('\n'),
        );
    }
}