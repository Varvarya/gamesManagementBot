import { RepositoriesContext } from '../../app/repositories.context';
import { PlayerService } from '../players/player.service';
import { Player } from '../players/player.types';
import { TrainingParticipantsService, ParticipantMutation } from './training-participants.service';

export type CreatePlayerAndAddToTrainingInput = {
    clubId: string;
    trainingId: string;
    displayName: string;
    places: number;
    createdByTelegramId: number;
};

export class TrainingPlayerCreationService {
    constructor(
        private readonly repositories: RepositoriesContext,
        private readonly players: PlayerService,
        private readonly participants: TrainingParticipantsService,
    ) {}

    async createPlayerAndAddToTraining(input: CreatePlayerAndAddToTrainingInput): Promise<{ player: Player; mutation: ParticipantMutation }> {
        const training = await this.repositories.trainings.findById(input.trainingId);
        if (!training || training.clubId !== input.clubId) throw new Error('Training does not belong to the active club');
        const trainingBefore = structuredClone(training);

        let player: Player | undefined;
        try {
            player = await this.players.createUnconfirmedByAdmin(input.displayName);
            const mutation = await this.participants.addParticipant({
                trainingId: input.trainingId,
                playerId: player.id,
                displayName: player.displayName,
                places: input.places,
                source: 'admin',
                overrideState: true,
            });
            return { player, mutation };
        } catch (error) {
            try { await this.repositories.trainings.save(trainingBefore); } catch { /* retain original error */ }
            if (player) await this.repositories.players.delete(player.id);
            throw error;
        }
    }
}
