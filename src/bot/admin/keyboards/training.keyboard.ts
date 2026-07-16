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
) {
    const registrationButton =
        training.status === 'open'
            ? Markup.button.callback(
                '🔒 Закрити запис',
                `${AdminCallbacks.TrainingClosePrefix}${training.id}`,
            )
            : Markup.button.callback(
                '🟢 Відкрити запис',
                `${AdminCallbacks.TrainingOpenPrefix}${training.id}`,
            );

    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '➕ Додати',
                `${AdminCallbacks.TrainingAddPlayerPrefix}${training.id}`,
            ),
            Markup.button.callback(
                '➖ Прибрати',
                `${AdminCallbacks.TrainingRemovePlayerPrefix}${training.id}`,
            ),
        ],
        [
            registrationButton,
            Markup.button.callback(
                '🔄 Оновити',
                `${AdminCallbacks.TrainingRefreshPrefix}${training.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '❌ Скасувати тренування',
                `${AdminCallbacks.TrainingCancelPrefix}${training.id}`,
            ),
        ],
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

export function createTrainingCancelKeyboard(
    trainingId: string,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '❌ Так, скасувати',
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
                `${prefix}${trainingId}:${player.id}`,
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

        default:
            return '⚪️';
    }
}