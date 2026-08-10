import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import { ParticipantEntry, ParticipantSource, Training } from './training.types';
import { TrainingService } from './training.service';
import { logger } from '../../utils/logger';
import { validateReservedPlaces } from './reserved-places';

type AddInput = {
    trainingId: string;
    playerId: string;
    displayName: string;
    telegramUserId?: number;
    places: number;
    source: ParticipantSource;
    overrideState?: boolean;
};

export type ParticipantMutation = {
    training: Training;
    outcome: 'registered' | 'waitlisted' | 'decremented' | 'removed' | 'not_registered';
    promotedPlayerIds: string[];
};

export class TrainingParticipantsService {
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly trainings: TrainingService) {}

    async addParticipant(input: AddInput): Promise<ParticipantMutation> {
        this.validatePlaces(input.places);
        const displayName = input.displayName.trim();
        if (!displayName) throw new Error('Participant display name is required');
        return this.serialize(input.trainingId, async () => {
            const training = await this.trainings.getRequired(input.trainingId);
            this.ensureTrainingIsOpen(training, input.overrideState);

            if (this.findParticipant(training, input.playerId)) {
                throw new Error('Player is already registered');
            }

            const participant: ParticipantEntry = {
                id: createId('participant'),
                playerId: input.playerId,
                displayName,
                telegramUserId: input.telegramUserId,
                places: input.places,
                source: input.source,
                status: this.countFreePlaces(training) >= input.places ? 'active' : 'waiting',
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            if (participant.status === 'active') training.participants.push(participant);
            else training.waitlist.push(participant);

            const saved = await this.trainings.save(training);
            logger.info('registration.added', { trainingId: saved.id, playerId: input.playerId, outcome: participant.status, source: input.source });
            return {
                training: saved,
                outcome: participant.status === 'active' ? 'registered' : 'waitlisted',
                promotedPlayerIds: [],
            };
        });
    }

    // Compatibility entry point used by the admin UI.
    async addOrUpdateParticipant(input: AddInput): Promise<Training> {
        return (await this.addParticipant(input)).training;
    }

    async removeParticipant(input: {
        trainingId: string;
        playerId: string;
        requestedPlacesToRemove: number;
        overrideState?: boolean;
    }): Promise<ParticipantMutation> {
        const requestedPlacesToRemove = input.requestedPlacesToRemove;
        this.validatePlaces(requestedPlacesToRemove);
        return this.serialize(input.trainingId, async () => {
            const training = await this.trainings.getRequired(input.trainingId);
            this.ensureTrainingIsOpen(training, input.overrideState);
            const participant = this.findParticipant(training, input.playerId);
            if (!participant) return { training, outcome: 'not_registered', promotedPlayerIds: [] };

            const wasActive = participant.status === 'active';
            let outcome: ParticipantMutation['outcome'];
            if (participant.places > requestedPlacesToRemove) {
                participant.places -= requestedPlacesToRemove;
                participant.updatedAt = nowIso();
                outcome = 'decremented';
            } else {
                training.participants = training.participants.filter((entry) => entry.playerId !== input.playerId);
                training.waitlist = training.waitlist.filter((entry) => entry.playerId !== input.playerId);
                outcome = 'removed';
            }

            const promotedPlayerIds = wasActive ? this.promoteWaitlist(training) : [];
            const saved = await this.trainings.save(training);
            logger.info('registration.removed', { trainingId: saved.id, playerId: input.playerId, outcome, remainingPlaces: outcome === 'decremented' ? participant.places : 0, promotedPlayerIds });
            return {
                training: saved,
                outcome,
                promotedPlayerIds,
            };
        });
    }

    async removeParticipantPlaces(input: { trainingId: string; playerId: string; places: number }): Promise<Training> {
        this.validatePlaces(input.places);
        return (await this.removeParticipant({ ...input, requestedPlacesToRemove: input.places })).training;
    }

    async removeParticipantCompletely(input: { trainingId: string; playerId: string; overrideState?: boolean }): Promise<Training> {
        return this.serialize(input.trainingId, async () => {
            const training = await this.trainings.getRequired(input.trainingId);
            this.ensureTrainingIsOpen(training, input.overrideState);
            const participant = this.findParticipant(training, input.playerId);
            if (!participant) return training;
            const wasActive = participant.status === 'active';
            training.participants = training.participants.filter((entry) => entry.playerId !== input.playerId);
            training.waitlist = training.waitlist.filter((entry) => entry.playerId !== input.playerId);
            if (wasActive) this.promoteWaitlist(training);
            return this.trainings.save(training);
        });
    }

    countActivePlaces(training: Training): number {
        return training.participants.reduce((sum, entry) => sum + entry.places, 0);
    }

    countFreePlaces(training: Training): number {
        return Math.max(training.placesLimit - this.countActivePlaces(training), 0);
    }

    private findParticipant(training: Training, playerId: string): ParticipantEntry | undefined {
        return [...training.participants, ...training.waitlist].find((entry) => entry.playerId === playerId);
    }

    private promoteWaitlist(training: Training): string[] {
        const promoted: string[] = [];
        while (this.countFreePlaces(training) > 0 && training.waitlist.length > 0) {
            const free = this.countFreePlaces(training);
            const index = training.waitlist.findIndex((entry) => entry.places <= free);
            if (index < 0) break;
            const [next] = training.waitlist.splice(index, 1);
            next.status = 'active';
            next.updatedAt = nowIso();
            training.participants.push(next);
            promoted.push(next.playerId);
        }
        return promoted;
    }

    private ensureTrainingIsOpen(training: Training, override = false): void {
        if (training.status === 'archived' || training.status === 'finished') {
            throw new Error('Archived training is read-only');
        }
        if (!override && training.status !== 'open') throw new Error('Training is not open');
    }

    private validatePlaces(places: number): void {
        validateReservedPlaces(places);
    }

    private async serialize<T>(trainingId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(trainingId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        this.queues.set(trainingId, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.queues.get(trainingId) === current) this.queues.delete(trainingId);
        }
    }
}
