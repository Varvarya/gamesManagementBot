import { Context } from 'telegraf';

import { ServicesContext } from '../../app/services.context';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';
import { logger } from '../../utils/logger';
import { isValidReservedPlaces } from '../../domain/trainings/reserved-places';

export type ParsedCommand = {
    action: '+' | '-';
    places: number;
    playerName?: string;
    date?: string;
    startTime?: string;
};

export class GroupRegistrationHandler {
    private readonly handledUpdates =
        new Set<number>();

    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
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

        if (
            !message.text
                .trim()
                .match(/^[+-]/)
        ) {
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

        const command =
            this.parseCommand(
                message.text,
            );

        if (!command) {
            await ctx.reply(
                'Невірний формат. Використайте +1…+4, +2 Імʼя або -1…-4.',
            );

            return;
        }

        const replyToMessageId =
            'reply_to_message' in
            message &&
            message.reply_to_message
                ? message
                    .reply_to_message
                    .message_id
                : undefined;

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
            chatId:
            message.chat.id,
            replyToMessageId,
            places:
            command.places,
            playerName:
            command.playerName,
            date:
            command.date,
            startTime:
            command.startTime,
        };

        try {
            const result =
                command.action === '+'
                    ? await this.services.registration.registerDetailed(
                        input,
                    )
                    : await this.services.registration.unregisterDetailed(
                        input,
                    );

            if (
                result.outcome !==
                'not_registered'
            ) {
                await this.publisher.refreshMessage(
                    result.training.id,
                );
            }

            if (
                result.outcome ===
                'not_registered'
            ) {
                const feedbackMessage =
                    await ctx.reply(
                        'ℹ️ Ви не були зареєстровані на це тренування.',
                    );

                await this.deleteFeedbackIfEnabled(
                    ctx,
                    feedbackMessage
                        .message_id,
                );

                return;
            }
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

    private parseCommand(
        text: string,
    ): ParsedCommand | undefined {
        return parseRegistrationCommand(text);
    }

    private errorFeedback(
        error: unknown,
    ): string {
        const message =
            error instanceof Error
                ? error.message
                : '';

        if (
            message.includes(
                'already registered',
            )
        ) {
            return 'ℹ️ Цей гравець уже зареєстрований.';
        }

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

    private async deleteFeedbackIfEnabled(
        ctx: Context,
        messageId: number,
    ): Promise<void> {
        const settings =
            await this.services.repositories.settings.get();

        if (
            !settings.cleanChatMode ||
            !ctx.chat?.id
        ) {
            return;
        }

        const chatId =
            ctx.chat.id;

        setTimeout(() => {
            ctx.telegram
                .deleteMessage(
                    chatId,
                    messageId,
                )
                .catch(
                    error =>
                        logger.warn(
                            'telegram.feedback_cleanup_failed',
                            {
                                chatId,
                                messageId,
                                error,
                            },
                        ),
                );
        }, 8_000);
    }
}

export function parseRegistrationCommand(text: string): ParsedCommand | undefined {
        const value =
            text.trim();

        const minus = value.match(/^-(\d+)$/);
        if (minus && isValidReservedPlaces(Number(minus[1]))) {
            return {
                action: '-',
                places: Number(minus[1]),
            };
        }

        const plus =
            value.match(
                /^\+(\d+)(?:\s+(.+))?$/i,
            );

        if (!plus) {
            return undefined;
        }

        const places =
            Number(plus[1]);

        if (!isValidReservedPlaces(places)) return undefined;

        let remainder:
            | string
            | undefined =
            plus[2]?.trim();

        let date:
            | string
            | undefined;

        let startTime:
            | string
            | undefined;

        const selector =
            remainder?.match(
                /^(.*?)(?:\s+)?at\s+(?:(\d{4}-\d{2}-\d{2})\s+)?([01]\d|2[0-3]):([0-5]\d)$/i,
            );

        if (selector) {
            const name =
                selector[1].trim();

            remainder =
                name.length > 0
                    ? name
                    : undefined;

            date =
                selector[2];

            startTime =
                `${selector[3]}:${selector[4]}`;
        }

        return {
            action: '+',
            places,
            playerName:
            remainder,
            date,
            startTime,
        };
}
