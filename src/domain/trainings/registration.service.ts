import { PlayerService } from '../players/player.service';
import { TrainingService } from './training.service';
import { ParticipantMutation, TrainingParticipantsService } from './training-participants.service';
import { Training } from './training.types';
import { validateReservedPlaces } from './reserved-places';
import { RegistrationCommand } from './registration-command.parser';

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

export type ExecuteRegistrationCommandInput = Omit<RegistrationActionInput, 'places' | 'playerName'> & { command: RegistrationCommand };
export type RegistrationResolution =
    | { kind: 'ready'; training: Training }
    | { kind: 'select'; trainings: Training[] }
    | { kind: 'none'; reason: 'NO_OPEN_TRAINING' | 'NO_REMOVABLE_REGISTRATION' };

export class RegistrationService {
    constructor(
        private readonly players: PlayerService,
        private readonly trainings: TrainingService,
        private readonly participants: TrainingParticipantsService,
    ) {}

    async executeCommand(input: ExecuteRegistrationCommandInput): Promise<ParticipantMutation[]> {
        const resolution = await this.resolveCommand(input);
        if (resolution.kind === 'none') throw new Error(resolution.reason);
        if (resolution.kind === 'select') throw new Error('TRAINING_SELECTION_REQUIRED');
        return this.executeCommandAgainstTraining(input, resolution.training.id);
    }

    async resolveCommand(input: ExecuteRegistrationCommandInput): Promise<RegistrationResolution> {
        if (input.replyToMessageId) {
            const replied = await this.trainings.findByMessageId(input.chatId, input.replyToMessageId);
            if (replied && this.trainings.isRelevantOpen(replied, input.chatId)) return { kind: 'ready', training: replied };
            return { kind: 'none', reason: input.command.operation === 'add' ? 'NO_OPEN_TRAINING' : 'NO_REMOVABLE_REGISTRATION' };
        }
        let candidates = await this.trainings.listRelevantOpenByChatId(input.chatId);
        if (input.command.operation === 'remove') candidates = await this.filterRemovableCandidates(candidates, input);
        const hint = input.command.trainingHint;
        if (hint) {
            const hinted = candidates.filter((training) => matchesTrainingHint(training, hint));
            if (hinted.length === 1) return { kind: 'ready', training: hinted[0] };
            if (hinted.length > 1) candidates = hinted;
            // A convenience hint that matches nothing must not turn numeric text
            // into a player or bypass the normal selector fallback.
        } else if (input.date || input.startTime) {
            candidates = candidates.filter((training) =>
                (!input.date || training.date === input.date) && (!input.startTime || training.startTime === input.startTime));
        }
        if (!candidates.length) return { kind: 'none', reason: input.command.operation === 'add' ? 'NO_OPEN_TRAINING' : 'NO_REMOVABLE_REGISTRATION' };
        if (candidates.length === 1) return { kind: 'ready', training: candidates[0] };
        return { kind: 'select', trainings: candidates };
    }

    async executeCommandAgainstTraining(input: ExecuteRegistrationCommandInput, trainingId: string): Promise<ParticipantMutation[]> {
        const training = await this.trainings.getRequired(trainingId);
        if (!this.trainings.isRelevantOpen(training, input.chatId)) throw new Error('TRAINING_NO_LONGER_OPEN');
        const owner = input.telegramUser.id;
        const command = input.command;
        if (command.operation === 'add') {
            if (command.targetType === 'self') {
                const player = await this.players.findOrCreateByTelegramUser(input.telegramUser);
                return [await this.participants.addParticipant({
                    trainingId: training.id, playerId: player.id, displayName: player.displayName,
                    telegramUserId: player.telegramUserId, registeredByTelegramUserId: owner,
                    places: command.count, source: 'telegram_self',
                })];
            }
            const players = [];
            for (const name of command.targetNames) players.push(await this.players.resolveOrCreateTelegramGuest(name));
            const places = command.targetNames.length === 1 ? command.count : 1;
            return this.participants.addParticipants(players.map((player) => ({
                trainingId: training.id, playerId: player.id, displayName: player.displayName,
                telegramUserId: player.telegramUserId, registeredByTelegramUserId: owner,
                places, source: 'telegram_guest' as const,
            })));
        }

        if (command.targetType === 'self') {
            const player = await this.players.findByTelegramId(owner);
            if (!player) throw new Error('SELF_NOT_REGISTERED');
            return [await this.participants.removeOwnedSelf({ trainingId: training.id, playerId: player.id, registeredByTelegramUserId: owner, places: command.count })];
        }
        const players = [];
        for (const name of command.targetNames) {
            const player = await this.players.resolveByStrongName(name);
            if (!player) throw new Error(`NAMED_NOT_OWNED:${name}`);
            players.push(player);
        }
        try {
            return await this.participants.removeOwnedNamed({
                trainingId: training.id, playerIds: players.map((player) => player.id),
                registeredByTelegramUserId: owner, placesPerEntry: command.targetNames.length > 1 ? 1 : command.count,
            });
        } catch (error) {
            if (error instanceof Error && error.message === 'NAMED_NOT_OWNED') {
                throw new Error(`NAMED_NOT_OWNED:${command.targetNames.join(', ')}`);
            }
            throw error;
        }
    }

    private async filterRemovableCandidates(candidates: Training[], input: ExecuteRegistrationCommandInput): Promise<Training[]> {
        const owner = input.telegramUser.id;
        if (input.command.targetType === 'self') {
            const player = await this.players.findByTelegramId(owner);
            if (!player) return [];
            return candidates.filter((training) => [...training.participants, ...training.waitlist]
                .some((entry) => (entry.source === 'telegram_self' || entry.source === 'telegram') && (entry.registeredByTelegramUserId === owner || (entry.registeredByTelegramUserId === undefined && entry.telegramUserId === owner)) && (entry.playerId === player.id || entry.telegramUserId === owner)));
        }
        const resolved: string[] = [];
        for (const name of input.command.targetNames) {
            const player = await this.players.resolveByStrongName(name);
            if (!player) return [];
            resolved.push(player.id);
        }
        return candidates.filter((training) => resolved.every((playerId) => [...training.participants, ...training.waitlist]
            .some((entry) => entry.playerId === playerId && entry.registeredByTelegramUserId === owner)));
    }

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
            source: input.playerName ? 'telegram_guest' : 'telegram_self',
            registeredByTelegramUserId: input.telegramUser.id,
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

    private async resolveOpenTraining(input: Pick<RegistrationActionInput, 'chatId' | 'replyToMessageId' | 'date' | 'startTime'>): Promise<Training> {
        const training = await this.trainings.resolveTargetTraining(input);
        if (!training) throw new Error('Target training not found or is ambiguous');
        if (training.status !== 'open') throw new Error('Training is not open');
        return training;
    }
}

function matchesTrainingHint(training: Training, hint: NonNullable<RegistrationCommand['trainingHint']>): boolean {
    if (hint.time && training.startTime !== hint.time) return false;
    if (hint.endTime && training.endTime !== hint.endTime) return false;
    if (hint.naturalDate) {
        const date = new Date();
        if (hint.naturalDate === 'tomorrow') date.setUTCDate(date.getUTCDate() + 1);
        if (training.date !== dateInKyiv(date)) return false;
    }
    if (hint.date) {
        if (/^\d{4}-/.test(hint.date) && training.date !== hint.date) return false;
        if (/^\d{2}\.\d{2}$/.test(hint.date)) {
            const [, month, day] = training.date.match(/^\d{4}-(\d{2})-(\d{2})$/) ?? [];
            if (`${day}.${month}` !== hint.date) return false;
        }
    }
    return true;
}

function dateInKyiv(value: Date): string {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
}
