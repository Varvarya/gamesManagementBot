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
    registeredByTelegramUserId?: number;
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
        return (await this.addParticipants([input]))[0];
    }

    async addParticipants(inputs: AddInput[]): Promise<ParticipantMutation[]> {
        if (!inputs.length) return [];
        const trainingId = inputs[0].trainingId;
        if (inputs.some((input) => input.trainingId !== trainingId)) throw new Error('Participants must belong to one training');
        for (const input of inputs) {
            this.validatePlaces(input.places);
            if (!input.displayName.trim()) throw new Error('Participant display name is required');
        }
        return this.serialize(trainingId, async () => {
            const training = await this.trainings.getRequired(trainingId);
            this.ensureTrainingIsOpen(training, inputs.some((input) => input.overrideState));
            const outcomes: ParticipantMutation[] = [];
            for (const input of inputs) {
                if (input.registeredByTelegramUserId === undefined && this.findParticipant(training, input.playerId)) {
                    throw new Error('Player is already registered');
                }
                if (input.source === 'telegram_self' && input.registeredByTelegramUserId !== undefined) {
                    const ownedPlaces = this.ownedSelfEntries(training, input.playerId, input.registeredByTelegramUserId)
                        .reduce((sum, entry) => sum + entry.places, 0);
                    if (ownedPlaces + input.places > 4) throw new Error('MAX_REGISTRATION_PLACES');
                }
                const existing = this.findOwnedParticipant(training, input.playerId, input.registeredByTelegramUserId);
            if (existing) {
                if (input.source !== 'telegram_self' && existing.places + input.places > 4) throw new Error('MAX_REGISTRATION_PLACES');
                const wasActive = existing.status === 'active';
                if (wasActive && this.countFreePlaces(training) < input.places) {
                    training.participants = training.participants.filter((entry) => entry.id !== existing.id);
                    existing.status = 'waiting';
                    training.waitlist.push(existing);
                }
                existing.places += input.places;
                existing.updatedAt = nowIso();
                outcomes.push({ training, outcome: existing.status === 'active' ? 'registered' : 'waitlisted', promotedPlayerIds: wasActive && existing.status === 'waiting' ? this.promoteWaitlist(training) : [] });
                continue;
            }
            const participant: ParticipantEntry = {
                id: createId('participant'),
                playerId: input.playerId,
                displayName: input.displayName.trim(),
                telegramUserId: input.telegramUserId,
                registeredByTelegramUserId: input.registeredByTelegramUserId,
                places: input.places,
                source: input.source,
                status: this.countFreePlaces(training) >= input.places ? 'active' : 'waiting',
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            if (participant.status === 'active') training.participants.push(participant);
            else training.waitlist.push(participant);
            outcomes.push({
                training,
                outcome: participant.status === 'active' ? 'registered' : 'waitlisted',
                promotedPlayerIds: [],
            });
            }
            const saved = await this.trainings.save(training);
            for (const input of inputs) logger.info('registration.added', { trainingId: saved.id, playerId: input.playerId, registeredByTelegramUserId: input.registeredByTelegramUserId, source: input.source });
            return outcomes.map((outcome) => ({ ...outcome, training: saved }));
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

    async removeOwnedSelf(input: { trainingId: string; playerId: string; registeredByTelegramUserId: number; places: number }): Promise<ParticipantMutation> {
        this.validatePlaces(input.places);
        return this.serialize(input.trainingId, async () => {
            const training = await this.trainings.getRequired(input.trainingId);
            this.ensureTrainingIsOpen(training);
            const owned = this.ownedSelfEntries(training, input.playerId, input.registeredByTelegramUserId);
            if (!owned.length) throw new Error('SELF_NOT_REGISTERED');

            let remaining = input.places;
            let removedPlaces = 0;
            let freedActive = false;
            // Cancelling queue reservations first is deterministic and avoids
            // promoting a place that the same owner immediately removes.
            for (const entry of owned) {
                if (remaining === 0) break;
                const decrement = Math.min(entry.places, remaining);
                entry.places -= decrement;
                remaining -= decrement;
                removedPlaces += decrement;
                freedActive ||= entry.status === 'active' && decrement > 0;
                if (entry.places === 0) {
                    training.participants = training.participants.filter((item) => item.id !== entry.id);
                    training.waitlist = training.waitlist.filter((item) => item.id !== entry.id);
                } else entry.updatedAt = nowIso();
            }

            const promotedPlayerIds = freedActive ? this.promoteWaitlist(training) : [];
            const saved = await this.trainings.save(training);
            const remainingPlaces = this.ownedSelfEntries(saved, input.playerId, input.registeredByTelegramUserId).reduce((sum, entry) => sum + entry.places, 0);
            const outcome: ParticipantMutation['outcome'] = remainingPlaces > 0 ? 'decremented' : 'removed';
            logger.info('registration.removed', { trainingId: saved.id, playerId: input.playerId, registeredByTelegramUserId: input.registeredByTelegramUserId, requestedPlaces: input.places, removedPlaces, remainingPlaces, outcome, promotedPlayerIds });
            return { training: saved, outcome, promotedPlayerIds };
        });
    }

    async removeOwnedNamed(input: { trainingId: string; playerIds: string[]; registeredByTelegramUserId: number; placesPerEntry: number }): Promise<ParticipantMutation[]> {
        return this.removeOwnedEntries(input.trainingId, input.playerIds.map((playerId) => ({ playerId, places: input.placesPerEntry })), input.registeredByTelegramUserId, false);
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

    private findOwnedParticipant(training: Training, playerId: string, owner: number | undefined): ParticipantEntry | undefined {
        return [...training.participants, ...training.waitlist].find((entry) => entry.playerId === playerId && entry.registeredByTelegramUserId === owner);
    }

    private ownedSelfEntries(training: Training, playerId: string, owner: number): ParticipantEntry[] {
        const isOwnedSelf = (entry: ParticipantEntry) => (entry.source === 'telegram_self' || entry.source === 'telegram')
            && (entry.registeredByTelegramUserId === owner || (entry.registeredByTelegramUserId === undefined && entry.telegramUserId === owner))
            && (entry.playerId === playerId || entry.telegramUserId === owner);
        const newestFirst = (a: ParticipantEntry, b: ParticipantEntry) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
        return [...training.waitlist.filter(isOwnedSelf).sort(newestFirst), ...training.participants.filter(isOwnedSelf).sort(newestFirst)];
    }

    private async removeOwnedEntries(trainingId: string, targets: Array<{ playerId: string; places: number }>, owner: number, self: boolean): Promise<ParticipantMutation[]> {
        for (const target of targets) this.validatePlaces(target.places);
        return this.serialize(trainingId, async () => {
            const training = await this.trainings.getRequired(trainingId);
            this.ensureTrainingIsOpen(training);
            const entries = targets.map((target) => ({ target, entry: this.findOwnedParticipant(training, target.playerId, owner) }));
            if (entries.some(({ entry }) => !entry)) throw new Error(self ? 'SELF_NOT_REGISTERED' : 'NAMED_NOT_OWNED');
            let freedActive = false;
            const results: ParticipantMutation[] = [];
            for (const { target, entry: value } of entries) {
                const entry = value!;
                const wasActive = entry.status === 'active';
                if (entry.places > target.places) {
                    entry.places -= target.places;
                    entry.updatedAt = nowIso();
                    results.push({ training, outcome: 'decremented', promotedPlayerIds: [] });
                } else {
                    training.participants = training.participants.filter((item) => item.id !== entry.id);
                    training.waitlist = training.waitlist.filter((item) => item.id !== entry.id);
                    results.push({ training, outcome: 'removed', promotedPlayerIds: [] });
                }
                freedActive ||= wasActive;
            }
            const promotedPlayerIds = freedActive ? this.promoteWaitlist(training) : [];
            const saved = await this.trainings.save(training);
            return results.map((result) => ({ ...result, training: saved, promotedPlayerIds }));
        });
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
