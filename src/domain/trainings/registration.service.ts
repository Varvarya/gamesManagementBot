import { PlayerService } from '../players/player.service';
import { TrainingService } from './training.service';
import { ParticipantMutation, TrainingParticipantsService } from './training-participants.service';
import { Training } from './training.types';
import { validateReservedPlaces } from './reserved-places';

type TelegramUserInput = { id: number; first_name?: string; username?: string };
export type RegistrationActionInput = {
    telegramUser: TelegramUserInput;
    chatId: number;
    replyToMessageId?: number;
    places: number;
    playerName?: string;
    date?: string;
    startTime?: string;
};

export class RegistrationService {
    constructor(
        private readonly players: PlayerService,
        private readonly trainings: TrainingService,
        private readonly participants: TrainingParticipantsService,
    ) {}

    async registerDetailed(input: RegistrationActionInput): Promise<ParticipantMutation> {
        validateReservedPlaces(input.places);
        const training = await this.resolveOpenTraining(input);
        const player = input.playerName
            ? await this.players.findOrCreateByName(input.playerName)
            : await this.players.findOrCreateByTelegramUser(input.telegramUser);
        return this.participants.addParticipant({
            trainingId: training.id,
            playerId: player.id,
            displayName: player.displayName,
            telegramUserId: player.telegramUserId,
            places: input.places,
            source: 'telegram',
        });
    }

    async register(input: RegistrationActionInput): Promise<Training> {
        return (await this.registerDetailed(input)).training;
    }

    async unregisterDetailed(input: RegistrationActionInput): Promise<ParticipantMutation> {
        validateReservedPlaces(input.places);
        const training = await this.resolveOpenTraining(input);
        const player = input.playerName
            ? await this.players.findOrCreateByName(input.playerName)
            : await this.players.findOrCreateByTelegramUser(input.telegramUser);
        return this.participants.removeParticipant({ trainingId: training.id, playerId: player.id, requestedPlacesToRemove: input.places });
    }

    async unregister(input: RegistrationActionInput): Promise<Training> {
        return (await this.unregisterDetailed(input)).training;
    }

    private async resolveOpenTraining(input: RegistrationActionInput): Promise<Training> {
        const training = await this.trainings.resolveTargetTraining(input);
        if (!training) throw new Error('Target training not found or is ambiguous');
        if (training.status !== 'open') throw new Error('Training is not open');
        return training;
    }
}
