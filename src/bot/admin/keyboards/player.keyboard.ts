import { Markup } from 'telegraf';
import { Player } from '../../../domain/players/player.types';
import { Training } from '../../../domain/trainings/training.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';

export function createPlayersKeyboard(
    _unconfirmedCount: number,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '🔎 Знайти гравця',
                AdminCallbacks.SearchPlayers,
            ),
        ],
        [
            Markup.button.callback(
                '➕ Додати гравця',
                AdminCallbacks.CreatePlayer,
            ),
        ],
        [Markup.button.callback('🆕 Очікують підтвердження', AdminCallbacks.UnconfirmedPlayers)],
        [Markup.button.callback('👥 Переглянути гравців', AdminCallbacks.AllPlayers)],
        [Markup.button.callback('🔴 Неактивні гравці', AdminCallbacks.InactivePlayers)],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.MainMenu,
            ),
        ],
    ]);
}

export function createPlayerBrowseKeyboard(page: number, totalPages: number, backCallback = AdminCallbacks.Players) {
    const pagination = [];
    if (page > 0) pagination.push(Markup.button.callback('⬅️ Попередня', AdminCallbacks.PlayerBrowsePrevious));
    if (page + 1 < totalPages) pagination.push(Markup.button.callback('Наступна ➡️', AdminCallbacks.PlayerBrowseNext));
    return Markup.inlineKeyboard([
        ...(pagination.length ? [pagination] : []),
        [Markup.button.callback('🔎 Пошук', AdminCallbacks.SearchPlayers)],
        [Markup.button.callback('◀️ Назад', backCallback)],
    ]);
}

export function createPlayerListKeyboard(
    _players: Player[],
    backCallback: string = AdminCallbacks.Players,
) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '◀️ Назад',
                backCallback,
            ),
        ],
    ]);
}

export function createNewPlayersKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔎 Знайти нового гравця', AdminCallbacks.PlayerNewSearch)],
        [Markup.button.callback('✅ Підтвердити за номером', AdminCallbacks.PlayerNewConfirm)],
        [Markup.button.callback('✏️ Редагувати за номером', AdminCallbacks.PlayerNewEdit)],
        [Markup.button.callback('🔗 Об’єднати дублікати', AdminCallbacks.PlayerNewMerge)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Players)],
    ]);
}

export function createKnownPlayersKeyboard(includeInactive = false) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔎 Пошук', AdminCallbacks.SearchPlayers)],
        [Markup.button.callback('➕ Додати', AdminCallbacks.CreatePlayer)],
        [Markup.button.callback('📋 Показати перші 10', AdminCallbacks.PlayerShowFirst)],
        [Markup.button.callback(includeInactive ? '✅ Неактивні включені' : '⛔ Включити неактивних', AdminCallbacks.PlayerIncludeInactive)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.Players)],
    ]);
}

export function createPlayerKeyboard(
    player: Player,
) {
    return Markup.inlineKeyboard([
        [player.isConfirmed
            ? Markup.button.callback('↩️ Зняти підтвердження', `${AdminCallbacks.PlayerUnconfirmPrefix}${player.id}`)
            : Markup.button.callback('✅ Підтвердити', `${AdminCallbacks.PlayerConfirmPrefix}${player.id}`)],
        [
            Markup.button.callback(
                '✏️ Змінити імʼя',
                `${AdminCallbacks.PlayerPrefix}${player.id}:rename`,
            ),
        ],
        [Markup.button.callback('➕ Додати alias', `${AdminCallbacks.PlayerAliasPrefix}${player.id}`)],
        [Markup.button.callback(player.isActive ? '⛔ Деактивувати' : '🟢 Активувати', `${AdminCallbacks.PlayerTogglePrefix}${player.id}`)],
        [Markup.button.callback('🔗 Обʼєднати', `${AdminCallbacks.PlayerMergePrefix}${player.id}`)],
        ...(!player.isConfirmed ? [[Markup.button.callback('🗑 Видалити помилково створеного', `${AdminCallbacks.PlayerDeletePrefix}${player.id}`)]] : []),
        [
            Markup.button.callback('➕ До тренування', `${AdminCallbacks.PlayerAddTrainingPrefix}${player.id}`),
            Markup.button.callback('➖ З тренування', `${AdminCallbacks.PlayerRemoveTrainingPrefix}${player.id}`),
        ],
        [
            Markup.button.callback(
                '◀️ Назад',
                AdminCallbacks.Players,
            ),
        ],
    ]);
}

export function createPlayerDeleteConfirmationKeyboard(playerId: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Так, видалити', `${AdminCallbacks.PlayerDeleteConfirmPrefix}${playerId}`)],
        [Markup.button.callback('◀️ До картки', `${AdminCallbacks.PlayerPrefix}${playerId}`)],
    ]);
}

export function createPlayerTrainingKeyboard(playerId: string, trainings: Training[], action: 'add' | 'remove') {
    const prefix = action === 'add' ? AdminCallbacks.PlayerSelectAddTrainingPrefix : AdminCallbacks.PlayerSelectRemoveTrainingPrefix;
    return Markup.inlineKeyboard([
        ...trainings.map((training) => [Markup.button.callback(`${training.date} ${training.startTime} — ${training.title}`, `${prefix}${training.id}`)]),
        [Markup.button.callback('◀️ Назад', `${AdminCallbacks.PlayerPrefix}${playerId}`)],
    ]);
}

export function createMergePreviewKeyboard(sourceId: string, targetId: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Підтвердити', AdminCallbacks.PlayerMergeConfirmPrefix)],
        [Markup.button.callback('◀️ Назад', `${AdminCallbacks.PlayerPrefix}${sourceId}`)],
    ]);
}

export function createMergeTargetKeyboard(sourceId: string, players: Player[]) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Назад', `${AdminCallbacks.PlayerPrefix}${sourceId}`)],
    ]);
}

export function createPlayerPreviewKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Підтвердити', AdminCallbacks.ConfirmCreatePlayer)],
        [Markup.button.callback('◀️ Назад', AdminCallbacks.CreatePlayer)],
        [Markup.button.callback('❌ Скасувати', AdminCallbacks.Players)],
    ]);
}

export function createDuplicateKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Створити все одно', AdminCallbacks.PlayerCreateAnyway)],
        [Markup.button.callback('❌ Скасувати', AdminCallbacks.Players)],
    ]);
}

export function createRenameDuplicateKeyboard(playerId: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Перейменувати все одно', AdminCallbacks.PlayerRenameAnyway)],
        [Markup.button.callback('◀️ До картки', `${AdminCallbacks.PlayerPrefix}${playerId}`)],
    ]);
}
