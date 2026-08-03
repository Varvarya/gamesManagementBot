import { Markup } from 'telegraf';
import { Player } from '../../../domain/players/player.types';
import { Training } from '../../../domain/trainings/training.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createActiveTrainingsKeyboard(
    trainings: Training[],
) {
    return Markup.inlineKeyboard([
        ...trainings.map((training) => [
            Markup.button.callback(
                `${getStatusIcon(training)} ${training.date} ${training.startTime} — ${countPlaces(training)}/${training.placesLimit}`,
                `${AdminCallbacks.TrainingPrefix}${training.id}`,
            ),
        ]),
        [Markup.button.callback('📦 Архів тренувань', AdminCallbacks.ArchivedTrainings)],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createTrainingKeyboard(
    training: Training,
    participantListTruncated = false,
) {
    const registrationButton =
        training.status === 'open'
            ? Markup.button.callback(
                '🔒 Закрити запис',
                `${AdminCallbacks.TrainingClosePrefix}${training.id}`,
            )
            : training.status === 'closed' ? Markup.button.callback(
                '🟢 Відкрити запис',
                `${AdminCallbacks.TrainingOpenPrefix}${training.id}`,
            ) : undefined;

    return Markup.inlineKeyboard([
        ...(participantListTruncated ? [[Markup.button.callback('👥 Показати всіх', `${AdminCallbacks.TrainingParticipantsPrefix}${training.id}`)]] : []),
        ...((training.status === 'open' || training.status === 'closed') ? [[
            Markup.button.callback(
                '➕ Додати',
                `${AdminCallbacks.TrainingAddPlayerPrefix}${training.id}`,
            ),
            Markup.button.callback(
                '➖ Прибрати',
                `${AdminCallbacks.TrainingRemovePlayerPrefix}${training.id}`,
            ),
        ]] : []),
        ...((training.status === 'open' || training.status === 'closed') ? [[
            ...(registrationButton ? [registrationButton] : []),
            Markup.button.callback('❌ Скасувати', `${AdminCallbacks.TrainingCancelPrefix}${training.id}`),
        ]] : []),
        ...((training.status === 'open' || training.status === 'closed') ? [[
            Markup.button.callback('✅ Завершити', `${AdminCallbacks.TrainingFinishPrefix}${training.id}`),
        ]] : []),
        [
            Markup.button.callback(
                '◀️ До списку',
                AdminCallbacks.ActiveTrainings,
            ),
            Markup.button.callback(
                '🏠 Меню',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createTrainingParticipantsKeyboard(training: Training) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Назад', `${AdminCallbacks.TrainingPrefix}${training.id}`)],
    ]);
}

export function createTrainingCancelKeyboard(
    trainingId: string,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '✅ Підтвердити скасування',
                `${AdminCallbacks.TrainingCancelConfirmPrefix}${trainingId}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                `${AdminCallbacks.TrainingPrefix}${trainingId}`,
            ),
        ],
    ]);
}

export function createTrainingPlayerSearchKeyboard(
    trainingId: string,
    players: Player[],
    action: 'add' | 'remove',
) {
    const prefix =
        action === 'add'
            ? AdminCallbacks.TrainingSelectAddPlayerPrefix
            : AdminCallbacks.TrainingSelectRemovePlayerPrefix;

    return Markup.inlineKeyboard([
        ...players.map((player) => [
            Markup.button.callback(
                player.displayName,
                `${prefix}${player.id}`,
            ),
        ]),
        [
            Markup.button.callback(
                '◀️ Назад',
                `${AdminCallbacks.TrainingPrefix}${trainingId}`,
            ),
        ],
    ]);
}

function countPlaces(
    training: Training,
): number {
    return training.participants.reduce(
        (sum, participant) =>
            sum + participant.places,
        0,
    );
}

function getStatusIcon(
    training: Training,
): string {
    switch (training.status) {
        case 'open':
            return '🟢';

        case 'closed':
            return '🔒';

        case 'cancelled':
            return '❌';

        case 'finished':
            return '✅';

        case 'archived':
            return '📦';

        default:
            return '⚪️';
    }
}

export function createArchivedTrainingsKeyboard(trainings: Training[], month?: string) {
    const current = month ?? new Date().toISOString().slice(0, 7);
    const [year, value] = current.split('-').map(Number);
    const previous = new Date(Date.UTC(year, value - 2, 1)).toISOString().slice(0, 7);
    const next = new Date(Date.UTC(year, value, 1)).toISOString().slice(0, 7);
    return Markup.inlineKeyboard([
        ...trainings.map((training) => [Markup.button.callback(`📦 ${training.date} ${training.startTime} — ${training.title}`, `${AdminCallbacks.ArchivedTrainingPrefix}${training.id}`)]),
        [Markup.button.callback('◀️ Місяць', `${AdminCallbacks.ArchiveMonthPrefix}${previous}`), Markup.button.callback('Місяць ▶️', `${AdminCallbacks.ArchiveMonthPrefix}${next}`)],
        [Markup.button.callback('🔎 Пошук', AdminCallbacks.ArchiveSearch)],
        [Markup.button.callback('◀️ До активних', AdminCallbacks.ActiveTrainings)],
    ]);
}

export function createArchivedTrainingKeyboard(training?: Training, participantListTruncated = false) {
    return Markup.inlineKeyboard([
        ...(training && participantListTruncated ? [[Markup.button.callback('👥 Показати всіх', `${AdminCallbacks.TrainingParticipantsPrefix}${training.id}`)]] : []),
        [Markup.button.callback('◀️ До архіву', AdminCallbacks.ArchivedTrainings)],
    ]);
}
