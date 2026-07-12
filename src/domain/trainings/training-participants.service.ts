import { createId } from '../../utils/ids';
import { nowIso } from '../../utils/date';
import {
    ParticipantEntry,
    ParticipantSource,
    Training,
} from './training.types';
import { TrainingService } from './training.service';

type AddOrUpdateParticipantInput = {
    trainingId: string;
    playerId: string;
    telegramUserId?: number;
    places: number;
    source: ParticipantSource;
};

type RemoveParticipantPlacesInput = {
    trainingId: string;
    playerId: string;
    places: number;
};

export class TrainingParticipantsService {
    constructor(
        private readonly trainings: TrainingService,
    ) {}

    async addOrUpdateParticipant(
        input: AddOrUpdateParticipantInput,
    ): Promise<Training> {
        this.validatePlaces(input.places);

        const training = await this.trainings.getRequired(input.trainingId);

        this.ensureTrainingIsOpen(training);

        const existing = this.findParticipant(training, input.playerId);

        if (existing) {
            existing.places = input.places;
            existing.updatedAt = nowIso();

            this.rebalanceWaitlist(training);

            return this.trainings.save(training);
        }

        const occupiedPlaces = this.countActivePlaces(training);

        const participant: ParticipantEntry = {
            id: createId('participant'),
            playerId: input.playerId,
            telegramUserId: input.telegramUserId,
            places: input.places,
            source: input.source,
            status:
                occupiedPlaces + input.places <= training.placesLimit
                    ? 'active'
                    : 'waiting',
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };

        if (participant.status === 'active') {
            training.participants.push(participant);
        } else {
            training.waitlist.push(participant);
        }

        this.rebalanceWaitlist(training);

        return this.trainings.save(training);
    }

    async removeParticipantPlaces(
        input: RemoveParticipantPlacesInput,
    ): Promise<Training> {
        this.validatePlaces(input.places);

        const training = await this.trainings.getRequired(input.trainingId);

        this.ensureTrainingIsOpen(training);

        const active = training.participants.find(
            (participant) => participant.playerId === input.playerId,
        );

        if (active) {
            active.places -= input.places;
            active.updatedAt = nowIso();

            if (active.places <= 0) {
                training.participants = training.participants.filter(
                    (participant) => participant.id !== active.id,
                );
            }

            this.rebalanceWaitlist(training);

            return this.trainings.save(training);
        }

        const waiting = training.waitlist.find(
            (participant) => participant.playerId === input.playerId,
        );

        if (waiting) {
            waiting.places -= input.places;
            waiting.updatedAt = nowIso();

            if (waiting.places <= 0) {
                training.waitlist = training.waitlist.filter(
                    (participant) => participant.id !== waiting.id,
                );
            }

            return this.trainings.save(training);
        }

        return training;
    }

    countActivePlaces(training: Training): number {
        return training.participants.reduce(
            (sum, participant) => sum + participant.places,
            0,
        );
    }

    countFreePlaces(training: Training): number {
        return Math.max(
            training.placesLimit - this.countActivePlaces(training),
            0,
        );
    }

    private findParticipant(
        training: Training,
        playerId: string,
    ): ParticipantEntry | undefined {
        return (
            training.participants.find(
                (participant) => participant.playerId === playerId,
            ) ||
            training.waitlist.find(
                (participant) => participant.playerId === playerId,
            )
        );
    }

    private rebalanceWaitlist(training: Training): void {
        let freePlaces = this.countFreePlaces(training);

        while (freePlaces > 0 && training.waitlist.length > 0) {
            const next = training.waitlist[0];

            if (next.places > freePlaces) {
                break;
            }

            training.waitlist.shift();

            next.status = 'active';
            next.updatedAt = nowIso();

            training.participants.push(next);

            freePlaces -= next.places;
        }
    }

    async removeParticipantCompletely(input: {
        trainingId: string;
        playerId: string;
    }): Promise<Training> {
        const training = await this.trainings.getRequired(
            input.trainingId,
        );

        training.participants =
            training.participants.filter(
                (participant) =>
                    participant.playerId !== input.playerId,
            );

        training.waitlist =
            training.waitlist.filter(
                (participant) =>
                    participant.playerId !== input.playerId,
            );

        this.rebalanceWaitlist(training);

        return this.trainings.save(training);
    }

    private ensureTrainingIsOpen(training: Training): void {
        if (training.status !== 'open') {
            throw new Error('Training is not open');
        }
    }

    private validatePlaces(places: number): void {
        if (!Number.isInteger(places) || places < 1 || places > 4) {
            throw new Error('places must be an integer from 1 to 4');
        }
    }
}