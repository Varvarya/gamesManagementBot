import { Markup } from 'telegraf';
import { Player } from '../../../domain/players/player.types';
import { Training } from '../../../domain/trainings/training.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createActiveTrainingsKeyboard(
    trainings: Training[],
) {
    return Markup.inlineKeyboard([
        ...(trainings.length ? [trainings.map((training, index) => Markup.button.callback(String(index + 1), `${AdminCallbacks.TrainingPrefix}${training.id}`))] : []),
        [Markup.button.callback('➕ Створити тренування', AdminCallbacks.TrainingCreate)],
        [Markup.button.callback('📅 Цей тиждень', AdminCallbacks.TrainingWeek), Markup.button.callback('🔎 Знайти', AdminCallbacks.TrainingSearch)],
        ...(!trainings.length ? [[Markup.button.callback('📅 Відкрити розклад', AdminCallbacks.Schedule)]] : []),
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.Back,
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
        ...((training.status === 'draft' || training.publicationStale) ? [[Markup.button.callback('📤 Опублікувати знову', `${AdminCallbacks.TrainingRepublishPrefix}${training.id}`)]] : []),
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
        ...(training.status === 'open' && training.messageId ? [[Markup.button.callback('🔄 Перевірити записи в чаті', `${AdminCallbacks.TrainingReconcilePrefix}${training.id}`)]] : []),
        ...((training.status === 'open' || training.status === 'closed') ? [[
            Markup.button.callback('✏️ Змінити', `${AdminCallbacks.TrainingEditPrefix}${training.id}`),
            ...(registrationButton ? [registrationButton] : []),
        ], [
            Markup.button.callback('❌ Скасувати', `${AdminCallbacks.TrainingCancelPrefix}${training.id}`),
        ]] : []),
        ...(training.status === 'cancelled' ? [[Markup.button.callback('📋 Список', `${AdminCallbacks.TrainingParticipantsPrefix}${training.id}`)]] : []),
        [
            Markup.button.callback(
                '◀️ До списку',
                AdminCallbacks.Back,
            ),
            Markup.button.callback(
                '🏠 Меню',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createTrainingWeekKeyboard(trainings: Training[], weekStart: string) {
    const start = new Date(`${weekStart}T00:00:00Z`);
    const shift = (days: number) => { const value = new Date(start); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
    return Markup.inlineKeyboard([
        ...(trainings.length ? [trainings.map((training, index) => Markup.button.callback(String(index + 1), `${AdminCallbacks.TrainingPrefix}${training.id}`))] : []),
        [Markup.button.callback('◀️ Попередній', `${AdminCallbacks.TrainingWeekPrefix}${shift(-7)}`), Markup.button.callback('Наступний ▶️', `${AdminCallbacks.TrainingWeekPrefix}${shift(7)}`)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.ActiveTrainings)],
    ]);
}

export function createTrainingEditKeyboard(training: Training) {
    const field = (value: string) => `${AdminCallbacks.TrainingEditFieldPrefix}${value}`;
    return Markup.inlineKeyboard([
        [Markup.button.callback('🕒 Час', field('time')), Markup.button.callback('👥 Ліміт', field('limit'))],
        [Markup.button.callback('🎯 Мінімум', field('minimum')), Markup.button.callback('💬 Чат', field('chat'))],
        [Markup.button.callback('📍 Місце', field('location')), Markup.button.callback('🏷 Назва', field('title'))],
        ...(training.templateId ? [[Markup.button.callback('📅 Відкрити розклад', AdminCallbacks.Schedule)]] : []),
        [Markup.button.callback('◀️ Назад', `${AdminCallbacks.TrainingPrefix}${training.id}`)],
    ]);
}

export function createTrainingCreateConfirmKeyboard(canSchedule = false) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Опублікувати зараз', AdminCallbacks.TrainingCreatePublishNow)],
        [Markup.button.callback('📝 Створити без публікації', AdminCallbacks.TrainingCreateDraft)],
        ...(canSchedule ? [[Markup.button.callback('🕒 Запланувати публікацію', AdminCallbacks.TrainingCreateSchedule)]] : []),
        [Markup.button.callback('✏️ Змінити', AdminCallbacks.TrainingCreate), Markup.button.callback('❌ Скасувати', AdminCallbacks.ActiveTrainings)],
    ]);
}

export function createTrainingParticipantsKeyboard(training: Training) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Back)],
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
                AdminCallbacks.Back,
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
                AdminCallbacks.Back,
            ),
        ],
    ]);
}

export function createTrainingRemoveSelectionKeyboard(training: Training) {
    const entries = [...training.participants, ...training.waitlist];
    return Markup.inlineKeyboard([
        ...(entries.length ? [entries.map((entry, index) => Markup.button.callback(String(index + 1), `${AdminCallbacks.TrainingSelectRemovePlayerPrefix}${entry.playerId}`))] : []),
        [Markup.button.callback('◀️ Назад', `${AdminCallbacks.TrainingPrefix}${training.id}`)],
    ]);
}

export function createTrainingRemovePlacesKeyboard(trainingId: string, places: number) {
    return Markup.inlineKeyboard([
        [1, 2, 3, 4].filter((value) => value <= places).map((value) => Markup.button.callback(`-${value}`, `${AdminCallbacks.TrainingRemovePlacesPrefix}${value}`)),
        [Markup.button.callback('Видалити повністю', `${AdminCallbacks.TrainingRemovePlacesPrefix}all`)],
        [Markup.button.callback('❌ Скасувати', `${AdminCallbacks.TrainingPrefix}${trainingId}`)],
    ]);
}

export function createUnknownTrainingPlayerKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Створити й додати', AdminCallbacks.TrainingNewPlayerPreview)],
        [Markup.button.callback('✏️ Змінити ім’я', AdminCallbacks.TrainingNewPlayerEdit)],
        [Markup.button.callback('🔎 Шукати ще раз', AdminCallbacks.TrainingNewPlayerSearchAgain)],
        [Markup.button.callback('❌ Скасувати', AdminCallbacks.TrainingNewPlayerCancel)],
    ]);
}

export function createNewTrainingPlayerPreviewKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Створити й додати', AdminCallbacks.TrainingNewPlayerConfirm)],
        [Markup.button.callback('✏️ Змінити ім’я', AdminCallbacks.TrainingNewPlayerEdit)],
        [Markup.button.callback('👥 Змінити кількість місць', AdminCallbacks.TrainingNewPlayerPlaces)],
        [Markup.button.callback('❌ Скасувати', AdminCallbacks.TrainingNewPlayerCancel)],
    ]);
}

export function createTrainingPlayerDuplicateKeyboard(players: Player[]) {
    return Markup.inlineKeyboard([
        ...players.slice(0, 10).map((player) => [
            Markup.button.callback(player.displayName, `${AdminCallbacks.TrainingSelectAddPlayerPrefix}${player.id}`),
        ]),
        [Markup.button.callback('➕ Все одно створити', AdminCallbacks.TrainingNewPlayerCreateAnyway)],
        [Markup.button.callback('✏️ Змінити пошук', AdminCallbacks.TrainingNewPlayerEdit)],
        [Markup.button.callback('❌ Скасувати', AdminCallbacks.TrainingNewPlayerCancel)],
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
