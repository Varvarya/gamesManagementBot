import { Markup } from 'telegraf';
import { TrainingTemplate } from '../../../domain/templates/template.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { Training } from '../../../domain/trainings/training.types';
import { Player } from '../../../domain/players/player.types';

export function createAdminMainKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '📅 Розклад',
                AdminCallbacks.Schedule,
            ),
        ],
        [
            Markup.button.callback(
                '🏸 Активні тренування',
                AdminCallbacks.ActiveTrainings,
            ),
        ],
        [
            Markup.button.callback(
                '👥 Гравці',
                AdminCallbacks.Players,
            ),
        ],
        [
            Markup.button.callback(
                '⚙️ Налаштування',
                AdminCallbacks.Settings,
            ),
        ],
    ]);
}

export function createScheduleKeyboard(
    templates: TrainingTemplate[],
) {
    const templateButtons = templates.map((template) => [
        Markup.button.callback(
            `${template.enabled ? '🟢' : '⚪️'} ${template.title}`,
            `${AdminCallbacks.TemplatePrefix}${template.id}`,
        ),
    ]);

    return Markup.inlineKeyboard([
        ...templateButtons,
        [
            Markup.button.callback(
                '➕ Новий шаблон',
                AdminCallbacks.CreateTemplate,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createTemplatePreviewKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '✅ Зберегти',
                AdminCallbacks.ConfirmCreateTemplate,
            ),
        ],
        [
            Markup.button.callback(
                '❌ Скасувати',
                AdminCallbacks.CancelCreateTemplate,
            ),
        ],
    ]);
}

export function createTemplateKeyboard(
    template: TrainingTemplate,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                template.enabled
                    ? '⏸ Вимкнути'
                    : '▶️ Увімкнути',
                `${AdminCallbacks.TemplateTogglePrefix}${template.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '✏️ Редагувати',
                `${AdminCallbacks.EditTemplatePrefix}${template.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '🗑 Видалити',
                `${AdminCallbacks.TemplateDeletePrefix}${template.id}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ До розкладу',
                AdminCallbacks.Schedule,
            ),
        ],
    ]);
}

export function createTemplateDeleteConfirmationKeyboard(
    templateId: string,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '🗑 Так, видалити',
                `${AdminCallbacks.TemplateDeleteConfirmPrefix}${templateId}`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Скасувати',
                `${AdminCallbacks.TemplatePrefix}${templateId}`,
            ),
        ],
    ]);
}

export function createBackKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createActiveTrainingsKeyboard(
    trainings: Training[],
) {
    const trainingButtons = trainings.map((training) => [
        Markup.button.callback(
            `${getTrainingStatusIcon(training)} ${training.date} ${training.startTime} — ${countPlaces(training)}/${training.placesLimit}`,
            `${AdminCallbacks.TrainingPrefix}${training.id}`,
        ),
    ]);

    return Markup.inlineKeyboard([
        ...trainingButtons,
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
    const statusButton =
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
                '➕ Додати гравця',
                `${AdminCallbacks.TrainingAddPlayerPrefix}${training.id}`,
            ),
            Markup.button.callback(
                '➖ Прибрати гравця',
                `${AdminCallbacks.TrainingRemovePlayerPrefix}${training.id}`,
            ),
        ],
        [
            statusButton,
        ],
        [
            Markup.button.callback(
                '🔄 Оновити повідомлення',
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
                '◀️ До активних',
                AdminCallbacks.ActiveTrainings,
            ),
        ],
    ]);
}

export function createTrainingCancelConfirmationKeyboard(
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

function countPlaces(training: Training): number {
    return training.participants.reduce(
        (sum, participant) =>
            sum + participant.places,
        0,
    );
}

function getTrainingStatusIcon(
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

export function createPlayersKeyboard(
    unconfirmedCount: number,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                `⚠️ Непідтверджені (${unconfirmedCount})`,
                AdminCallbacks.UnconfirmedPlayers,
            ),
        ],
        [
            Markup.button.callback(
                '👥 Всі гравці',
                AdminCallbacks.AllPlayers,
            ),
        ],
        [
            Markup.button.callback(
                '➕ Додати гравця',
                AdminCallbacks.CreatePlayer,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createPlayerListKeyboard(
    players: Player[],
) {
    return Markup.inlineKeyboard([
        ...players.map((player) => [
            Markup.button.callback(
                `${
                    player.isConfirmed
                        ? '👤'
                        : '⚠️'
                } ${player.displayName}`,
                `${AdminCallbacks.PlayerPrefix}${player.id}`,
            ),
        ]),
        [
            Markup.button.callback(
                '◀️ До гравців',
                AdminCallbacks.Players,
            ),
        ],
    ]);
}

export function createPlayerKeyboard(
    player: Player,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '✏️ Змінити імʼя',
                `${AdminCallbacks.PlayerPrefix}${player.id}:rename`,
            ),
        ],
        [
            Markup.button.callback(
                '◀️ До гравців',
                AdminCallbacks.Players,
            ),
        ],
    ]);
}