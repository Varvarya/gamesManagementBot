import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { Training } from '../../domain/trainings/training.types';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';

const REGISTRATION_COMMAND_REGEX = /^([+-])([1-4])$/;

type ParsedRegistrationCommand = {
    action: '+' | '-';
    places: number;
};

export class GroupRegistrationHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    async handle(ctx: Context): Promise<void> {
        const message = ctx.message;

        if (
            !message ||
            !('text' in message) ||
            !message.from ||
            message.chat.type === 'private'
        ) {
            return;
        }

        const command = this.parseCommand(message.text);

        if (!command) {
            return;
        }

        const replyToMessageId =
            'reply_to_message' in message && message.reply_to_message
                ? message.reply_to_message.message_id
                : undefined;

        try {
            const training =
                command.action === '+'
                    ? await this.services.registration.register({
                        telegramUser: {
                            id: message.from.id,
                            first_name: message.from.first_name,
                            username: message.from.username,
                        },
                        chatId: message.chat.id,
                        replyToMessageId,
                        places: command.places,
                    })
                    : await this.services.registration.unregister({
                        telegramUser: {
                            id: message.from.id,
                            first_name: message.from.first_name,
                            username: message.from.username,
                        },
                        chatId: message.chat.id,
                        replyToMessageId,
                        places: command.places,
                    });

            await this.publisher.refreshMessage(training.id);
        } catch (error) {
            // У групу нічого не відправляємо.
            // Пізніше тут буде ignored action log.
            console.error('Registration action ignored:', error);
        }
    }

    private parseCommand(
        text: string,
    ): ParsedRegistrationCommand | undefined {
        const match = text.trim().match(REGISTRATION_COMMAND_REGEX);

        if (!match) {
            return undefined;
        }

        return {
            action: match[1] as '+' | '-',
            places: Number(match[2]),
        };
    }
}