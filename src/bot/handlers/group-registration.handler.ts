import { Context, Markup } from 'telegraf';

import { ServicesContext } from '../../app/services.context';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';
import { logger } from '../../utils/logger';
import { registrationCommandParser, RegistrationCommand, RegistrationCommandParseError } from '../../domain/trainings/registration-command.parser';
import { PendingRegistrationSelectionStore, REGISTRATION_SELECTION_PREFIX } from '../registration/pending-registration-selection.store';
import { assertCallbackDataValid } from '../callback-data';
import { Training } from '../../domain/trainings/training.types';

export class GroupRegistrationHandler {
    private readonly handledUpdates =
        new Set<number>();

    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
        private readonly selections: PendingRegistrationSelectionStore = new PendingRegistrationSelectionStore(),
    ) {}

    async handle(
        ctx: Context,
    ): Promise<void> {
        const message =
            ctx.message;

        if (
            !message ||
            !('text' in message) ||
            !message.from ||
            message.chat.type === 'private'
        ) {
            return;
        }

        if (!registrationCommandParser.normalize(message.text).match(/^[+-]/)) {
            return;
        }

        const updateId =
            ctx.update.update_id;

        if (
            this.handledUpdates.has(
                updateId,
            )
        ) {
            return;
        }

        this.handledUpdates.add(
            updateId,
        );

        if (
            this.handledUpdates.size >
            10_000
        ) {
            this.handledUpdates.delete(
                this.handledUpdates
                    .values()
                    .next()
                    .value!,
            );
        }

        const replyToMessageId =
            'reply_to_message' in
            message &&
            message.reply_to_message
                ? message
                    .reply_to_message
                    .message_id
                : undefined;

        try {
            const command = registrationCommandParser.parse(message.text);
            if (!command) return;
            const input = {
                telegramUser: {
                id: message.from.id,
                first_name:
                message.from
                    .first_name,
                username:
                message.from
                    .username,
            },
                chatId: message.chat.id, replyToMessageId,
                date: command.date, startTime: command.startTime, command,
            };
            const resolution = await this.services.registration.resolveCommand(input);
            if (resolution.kind === 'none') throw new Error(resolution.reason);
            if (resolution.kind === 'select') {
                await this.showTrainingSelector(ctx, input, resolution.trainings);
                return;
            }
            const results = await this.services.registration.executeCommandAgainstTraining(input, resolution.training.id);
            const training = results[0]?.training;
            if (training) await this.publisher.refreshMessage(training.id);
        } catch (error) {
            logger.warn(
                'registration.action_rejected',
                {
                    chatId:
                    ctx.chat?.id,
                    updateId:
                    ctx.update
                        .update_id,
                    error,
                },
            );

            await ctx.reply(
                this.errorFeedback(
                    error,
                ),
            );
        }
    }

    async handleSelection(ctx: Context, callback: string): Promise<void> {
        if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        const result = this.selections.get(callback);
        if (result.status !== 'active') {
            await ctx.answerCbQuery('⚠️ Цей вибір уже неактуальний. Надішліть команду ще раз.', { show_alert: true });
            return;
        }
        const pending = result.value;
        if (pending.telegramUser.id !== ctx.from.id) {
            await ctx.answerCbQuery('⚠️ Це меню належить іншому користувачу.', { show_alert: true });
            return;
        }
        if (ctx.chat?.id !== pending.chatId || pending.clubId !== this.services.repositories.clubId) {
            await ctx.answerCbQuery('⚠️ Цей вибір уже неактуальний. Надішліть команду ще раз.', { show_alert: true });
            return;
        }
        try {
            const input = { telegramUser: pending.telegramUser, chatId: pending.chatId, command: pending.command };
            const results = await this.services.registration.executeCommandAgainstTraining(input, pending.trainingId);
            const training = results[0]?.training;
            if (training) await this.publisher.refreshMessage(training.id);
            this.selections.complete(pending.requestId);
            await ctx.answerCbQuery();
            await ctx.deleteMessage().catch(() => undefined);
        } catch (error) {
            this.selections.complete(pending.requestId);
            await ctx.answerCbQuery(this.errorFeedback(error), { show_alert: true });
        }
    }

    private async showTrainingSelector(
        ctx: Context,
        input: { telegramUser: { id: number; first_name?: string; username?: string }; chatId: number; command: RegistrationCommand },
        trainings: Training[],
    ): Promise<void> {
        const pending = this.selections.create({
            clubId: this.services.repositories.clubId,
            chatId: input.chatId,
            telegramUser: input.telegramUser,
            command: input.command,
            candidateTrainingIds: trainings.map((training) => training.id),
        });
        const rows = trainings.map((training, index) => {
            const callback = assertCallbackDataValid(`${REGISTRATION_SELECTION_PREFIX}${pending[index].token}`);
            return [Markup.button.callback(this.trainingLabel(training, trainings), callback)];
        });
        await ctx.reply('🏸 Оберіть тренування:', Markup.inlineKeyboard(rows));
    }

    private trainingLabel(training: Training, candidates: Training[]): string {
        const sameDate = candidates.every((item) => item.date === training.date);
        const date = training.date.match(/^\d{4}-(\d{2})-(\d{2})$/);
        const dateLabel = date ? `${date[2]}.${date[1]}` : training.date;
        return sameDate
            ? `${training.startTime}–${training.endTime}`
            : `${dateLabel} · ${training.startTime}–${training.endTime}`;
    }

    private errorFeedback(
        error: unknown,
    ): string {
        const message =
            error instanceof Error
                ? error.message
                : '';

        if (error instanceof RegistrationCommandParseError) return error.message;
        if (message.includes('MAX_REGISTRATION_PLACES')) return 'Максимум 4 місця на один запис.';
        if (message.includes('SELF_NOT_REGISTERED')) return 'Ви не записані на це тренування.';
        if (message.includes('NAMED_NOT_OWNED')) {
            const name = message.split(':')[1];
            return name ? `Ви не додавали гравця «${name}» на це тренування.` : 'Ви не додавали цього гравця на тренування.';
        }
        if (message.includes('AMBIGUOUS_PLAYER_NAME')) return 'Знайдено кілька гравців із таким імʼям. Уточніть імʼя.';
        if (message.includes('NO_OPEN_TRAINING')) return 'Зараз немає відкритого запису на тренування.';
        if (message.includes('NO_REMOVABLE_REGISTRATION')) return 'Не знайдено вашого запису, який можна скасувати.';
        if (message.includes('TRAINING_NO_LONGER_OPEN')) return 'Це тренування вже недоступне для реєстрації.';

        if (
            message.includes(
                'not open',
            )
        ) {
            return '🔒 Реєстрацію на це тренування закрито.';
        }

        if (
            message.includes(
                'not found',
            ) ||
            message.includes(
                'ambiguous',
            )
        ) {
            return '❓ Тренування не знайдено. Відповідайте на оголошення або вкажіть час: +1 at HH:mm (за потреби +2 Імʼя at YYYY-MM-DD HH:mm).';
        }

        return 'Не вдалося змінити реєстрацію. Перевірте формат і спробуйте ще раз.';
    }

}

export function parseRegistrationCommand(text: string): RegistrationCommand | undefined {
    return registrationCommandParser.parse(text);
}
