import { PlayerService } from '../players/player.service';
import { TrainingService } from './training.service';
import { TrainingParticipantsService } from './training-participants.service';
import { Training } from './training.types';

type TelegramUserInput = {
    id: number;
    first_name?: string;
    username?: string;
};

type RegistrationActionInput = {
    telegramUser: TelegramUserInput;
    chatId: number;
    replyToMessageId?: number;
    places: number;
};

export class RegistrationService {
    constructor(
        private readonly players: PlayerService,
        private readonly trainings: TrainingService,
        private readonly participants: TrainingParticipantsService,
    ) {}

    async register(input: RegistrationActionInput): Promise<Training> {
        const training = await this.resolveOpenTraining(input);

        const player = await this.players.findOrCreateByTelegramUser(
            input.telegramUser,
        );

        return this.participants.addOrUpdateParticipant({
            trainingId: training.id,
            playerId: player.id,
            telegramUserId: player.telegramUserId,
            places: input.places,
            source: 'telegram',
        });
    }

    async unregister(input: RegistrationActionInput): Promise<Training> {
        const training = await this.resolveOpenTraining(input);

        const player = await this.players.findOrCreateByTelegramUser(
            input.telegramUser,
        );

        return this.participants.removeParticipantPlaces({
            trainingId: training.id,
            playerId: player.id,
            places: input.places,
        });
    }

    private async resolveOpenTraining(
        input: RegistrationActionInput,
    ): Promise<Training> {
        const training = await this.trainings.resolveTargetTraining({
            chatId: input.chatId,
            replyToMessageId: input.replyToMessageId,
        });

        if (!training) {
            throw new Error('Target training not found');
        }

        if (training.status !== 'open') {
            throw new Error('Training is not open');
        }

        return training;
    }
}