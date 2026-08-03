import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createFlowCancelKeyboard, createFlowNavigationKeyboard } from '../keyboards/flow.keyboard';
import { createDuplicateKeyboard, createMergePreviewKeyboard, createPlayerDeleteConfirmationKeyboard, createPlayerKeyboard, createPlayerListKeyboard, createPlayerPreviewKeyboard, createPlayerTrainingKeyboard, createRenameDuplicateKeyboard } from '../keyboards/player.keyboard';
import { renderPlayerCard } from '../ui/admin-formatters';
import { AdminFlowState } from './admin-flow.types';
import { renderNumbered } from '../handlers/admin-player.handler';

export class PlayerFlowHandler {
    readonly textStates: readonly AdminFlowState[] = ['waiting_player_name', 'waiting_new_player_name', 'waiting_player_search', 'waiting_player_selection', 'waiting_player_alias', 'waiting_player_merge_target', 'waiting_player_merge_confirmation'];
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    canHandleCallback(
        callback: string,
    ): boolean {
        return (
            callback === AdminCallbacks.CreatePlayer ||
            callback === AdminCallbacks.ConfirmCreatePlayer ||
            callback === AdminCallbacks.SearchPlayers ||
            callback === AdminCallbacks.PlayerNewSearch ||
            callback === AdminCallbacks.PlayerNewConfirm ||
            callback === AdminCallbacks.PlayerNewEdit ||
            callback === AdminCallbacks.PlayerNewMerge ||
            callback === AdminCallbacks.PlayerIncludeInactive ||
            callback === AdminCallbacks.PlayerCreateAnyway ||
            callback === AdminCallbacks.PlayerRenameAnyway ||
            callback.startsWith(AdminCallbacks.PlayerConfirmPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerUnconfirmPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerAliasPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerTogglePrefix) ||
            callback.startsWith(AdminCallbacks.PlayerDeleteConfirmPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerDeletePrefix) ||
            callback.startsWith(AdminCallbacks.PlayerMergeTargetPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerMergeConfirmPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerMergePrefix) ||
            callback.startsWith(AdminCallbacks.PlayerSelectAddTrainingPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerSelectRemoveTrainingPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerAddTrainingPrefix) ||
            callback.startsWith(AdminCallbacks.PlayerRemoveTrainingPrefix) ||
            (
                callback.startsWith(
                    AdminCallbacks.PlayerPrefix,
                ) &&
                callback.endsWith(':rename')
            )
        );
    }

    async handleCallback(
        ctx: Context,
        callback: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        if (
            callback ===
            AdminCallbacks.CreatePlayer
        ) {
            this.services.adminFlow.transition(
                adminId,
                'waiting_new_player_name',
            );

            await this.services.adminUi.show(
                ctx,
                [
                    '➕ Новий гравець',
                    '',
                    'Надішліть імʼя одним повідомленням',
                ].join('\n'),
                createFlowCancelKeyboard(
                    AdminCallbacks.Players,
                ),
            );
            return;
        }

        if (callback === AdminCallbacks.ConfirmCreatePlayer) {
            const name = this.services.adminFlow.getData(adminId).pendingPlayerName;
            if (!name) {
                await this.services.adminUi.replaceWithError(ctx, 'Імʼя вже неактуальне. Створіть гравця ще раз.', createFlowCancelKeyboard(AdminCallbacks.Players));
                return;
            }
            try {
                const player = await this.services.players.createManual(name, Boolean(this.services.adminFlow.getData(adminId).allowDuplicatePlayerCreation));
                this.finishPlayerFlow(adminId);
                await this.services.adminUi.replaceWithSuccess(ctx, renderPlayerCard(player), createPlayerKeyboard(player));
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, error instanceof Error && error.message.includes('already exists') ? 'Гравець з таким імʼям або псевдонімом уже існує.' : 'Не вдалося створити гравця. Перевірте імʼя.', createFlowCancelKeyboard(AdminCallbacks.Players));
            }
            return;
        }

        if (callback === AdminCallbacks.PlayerNewConfirm || callback === AdminCallbacks.PlayerNewEdit || callback === AdminCallbacks.PlayerNewMerge) {
            const players = (await this.services.repositories.players.listUnconfirmed()).slice(0, 10);
            const action = callback === AdminCallbacks.PlayerNewConfirm ? 'confirm' : callback === AdminCallbacks.PlayerNewEdit ? 'edit' : 'merge_source';
            this.services.adminFlow.start(adminId, 'waiting_player_selection', {
                playerResultIds: players.map((player) => player.id),
                playerSelectionAction: action,
                returnCallback: AdminCallbacks.UnconfirmedPlayers,
            });
            const heading = action === 'confirm' ? '✅ Підтвердження' : action === 'edit' ? '✏️ Редагування' : '🔗 Обʼєднання';
            await this.services.adminUi.show(ctx, [`${heading} нового гравця`, '', renderNumbered(players), '', 'Надішліть номер гравця.'].join('\n'), createPlayerListKeyboard([], AdminCallbacks.UnconfirmedPlayers));
            return;
        }

        if (callback === AdminCallbacks.SearchPlayers || callback === AdminCallbacks.PlayerNewSearch) {
            const searchQuery = this.services.adminFlow.getData(adminId).searchQuery ?? '';
            this.services.adminFlow.start(adminId, 'waiting_player_search', { searchQuery, playerSelectionAction: 'open', playerSearchScope: callback === AdminCallbacks.PlayerNewSearch ? 'unconfirmed' : 'all', returnCallback: callback === AdminCallbacks.PlayerNewSearch ? AdminCallbacks.UnconfirmedPlayers : AdminCallbacks.KnownPlayers, includeInactive: false });
            await this.services.adminUi.show(ctx, ['🔎 Пошук гравця', '', 'Надішліть імʼя, Telegram-імʼя, username або alias.'].join('\n'), createPlayerListKeyboard([], callback === AdminCallbacks.PlayerNewSearch ? AdminCallbacks.UnconfirmedPlayers : AdminCallbacks.KnownPlayers));
            return;
        }

        if (callback === AdminCallbacks.PlayerIncludeInactive) {
            const data = this.services.adminFlow.getData(adminId);
            this.services.adminFlow.start(adminId, 'waiting_player_search', { ...data, includeInactive: !data.includeInactive, returnCallback: AdminCallbacks.KnownPlayers });
            await this.services.adminUi.show(ctx, `🔎 Пошук гравця\n\nНеактивні гравці ${!data.includeInactive ? 'включені' : 'виключені'}. Надішліть запит.`, createPlayerListKeyboard([], AdminCallbacks.KnownPlayers));
            return;
        }

        if (callback === AdminCallbacks.PlayerCreateAnyway) {
            const name = this.services.adminFlow.getData(adminId).pendingPlayerName;
            if (!name) { await this.services.adminUi.replaceWithError(ctx, 'Імʼя більше не актуальне.', createFlowCancelKeyboard(AdminCallbacks.Players)); return; }
            this.services.adminFlow.transition(adminId, 'waiting_new_player_name', { duplicatePlayerIds: [], allowDuplicatePlayerCreation: true });
            await this.services.adminUi.show(ctx, ['👀 Перевірте дані', '', `Імʼя: ${name}`, '', 'Створити нового гравця?'].join('\n'), createPlayerPreviewKeyboard());
            return;
        }

        if (callback === AdminCallbacks.PlayerRenameAnyway) {
            const data = this.services.adminFlow.getData(adminId);
            if (!data.playerId || !data.pendingPlayerName) { await this.services.adminUi.replaceWithError(ctx, 'Дані перейменування застаріли.', createFlowCancelKeyboard(AdminCallbacks.Players)); return; }
            try {
                const player = await this.services.players.updateName(data.playerId, data.pendingPlayerName);
                await this.publisher.refreshMessagesForPlayer(player.id);
                this.finishPlayerFlow(adminId);
                await this.services.adminUi.replaceWithSuccess(ctx, `Імʼя змінено.\n\n${renderPlayerCard(player)}`, createPlayerKeyboard(player));
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося змінити імʼя.', createRenameDuplicateKeyboard(data.playerId));
            }
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerMergeConfirmPrefix)) {
            const data = this.services.adminFlow.getData(adminId);
            const sourceId = data.sourcePlayerId;
            const targetId = data.targetPlayerId;
            if (!sourceId || !targetId) { await this.services.adminUi.replaceWithError(ctx, 'Дані обʼєднання застаріли.', createFlowCancelKeyboard(AdminCallbacks.Players)); return; }
            try {
                const target = await this.services.players.merge(sourceId, targetId);
                await this.publisher.refreshMessagesForPlayer(target.id);
                this.finishPlayerFlow(adminId);
                await this.services.adminUi.replaceWithSuccess(ctx, `Гравців обʼєднано.\n\n${renderPlayerCard(target)}`, createPlayerKeyboard(target));
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, `${error instanceof Error ? error.message : 'Не вдалося обʼєднати гравців.'}\n\nОберіть іншу пару або поверніться назад.`, createMergePreviewKeyboard(sourceId, targetId));
            }
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerSelectAddTrainingPrefix) || callback.startsWith(AdminCallbacks.PlayerSelectRemoveTrainingPrefix)) {
            const add = callback.startsWith(AdminCallbacks.PlayerSelectAddTrainingPrefix);
            const prefix = add ? AdminCallbacks.PlayerSelectAddTrainingPrefix : AdminCallbacks.PlayerSelectRemoveTrainingPrefix;
            const payload = callback.replace(prefix, '');
            const legacySeparator = payload.indexOf(':');
            const playerId = legacySeparator >= 0 ? payload.slice(0, legacySeparator) : this.services.adminFlow.getData(adminId).playerId;
            const trainingId = legacySeparator >= 0 ? payload.slice(legacySeparator + 1) : payload;
            if (!playerId) { await this.services.adminUi.replaceWithError(ctx, 'Картка гравця застаріла.', createFlowCancelKeyboard(AdminCallbacks.Players)); return; }
            try {
                if (add) {
                    const player = await this.services.repositories.players.findById(playerId);
                    if (!player) throw new Error('Гравця не знайдено');
                    const result = await this.services.trainingParticipants.addParticipant({ trainingId, playerId, displayName: player.displayName, telegramUserId: player.telegramUserId, places: 1, source: 'admin' });
                    await this.publisher.refreshMessage(trainingId);
                    await this.services.adminUi.replaceWithSuccess(ctx, result.outcome === 'waitlisted' ? 'Гравця додано до листа очікування' : 'Гравця додано до основного списку', createPlayerKeyboard(player));
                } else {
                    const result = await this.services.trainingParticipants.removeParticipant({ trainingId, playerId, overrideState: true });
                    if (result.outcome === 'not_registered') throw new Error('Гравець не зареєстрований');
                    await this.publisher.refreshMessage(trainingId);
                    const player = await this.services.repositories.players.findById(playerId);
                    await this.services.adminUi.replaceWithSuccess(ctx, result.promotedPlayerIds.length ? 'Гравця видалено, першого з черги підвищено' : 'Гравця видалено', createPlayerKeyboard(player!));
                }
                this.finishPlayerFlow(adminId);
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося змінити реєстрацію', createFlowCancelKeyboard(`${AdminCallbacks.PlayerPrefix}${playerId}`));
            }
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerAddTrainingPrefix) || callback.startsWith(AdminCallbacks.PlayerRemoveTrainingPrefix)) {
            const add = callback.startsWith(AdminCallbacks.PlayerAddTrainingPrefix);
            const prefix = add ? AdminCallbacks.PlayerAddTrainingPrefix : AdminCallbacks.PlayerRemoveTrainingPrefix;
            const playerId = callback.replace(prefix, '');
            this.services.adminFlow.setData(adminId, { playerId });
            const all = await this.services.repositories.trainings.listActive();
            const trainings = add ? all.filter((training) => training.status === 'open') : all.filter((training) => [...training.participants, ...training.waitlist].some((entry) => entry.playerId === playerId));
            await this.services.adminUi.show(ctx, trainings.length ? 'Оберіть тренування' : 'Відповідних тренувань немає', createPlayerTrainingKeyboard(playerId, trainings, add ? 'add' : 'remove'));
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerConfirmPrefix)) {
            const player = await this.services.players.confirm(callback.replace(AdminCallbacks.PlayerConfirmPrefix, ''));
            await this.services.adminUi.replaceWithSuccess(ctx, `Гравця підтверджено.\n\n${renderPlayerCard(player)}`, createPlayerKeyboard(player));
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerUnconfirmPrefix)) {
            const player = await this.services.players.setConfirmed(callback.replace(AdminCallbacks.PlayerUnconfirmPrefix, ''), false);
            await this.services.adminUi.replaceWithSuccess(ctx, `Підтвердження знято.\n\n${renderPlayerCard(player)}`, createPlayerKeyboard(player));
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerTogglePrefix)) {
            const id = callback.replace(AdminCallbacks.PlayerTogglePrefix, '');
            const current = await this.services.repositories.players.findById(id);
            if (!current) throw new Error('Гравця не знайдено');
            const player = await this.services.players.setActive(id, !current.isActive);
            await this.services.adminUi.replaceWithSuccess(ctx, `${player.isActive ? 'Гравця активовано.' : 'Гравця деактивовано.'}\n\n${renderPlayerCard(player)}`, createPlayerKeyboard(player));
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerDeleteConfirmPrefix)) {
            const playerId = callback.replace(AdminCallbacks.PlayerDeleteConfirmPrefix, '');
            try {
                await this.services.players.deleteMistakenPlayer(playerId);
                this.services.adminFlow.reset(adminId);
                await this.services.adminUi.replaceWithSuccess(ctx, 'Гравця видалено.', createFlowCancelKeyboard(AdminCallbacks.UnconfirmedPlayers));
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося видалити гравця.', createFlowCancelKeyboard(`${AdminCallbacks.PlayerPrefix}${playerId}`));
            }
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerDeletePrefix)) {
            const playerId = callback.replace(AdminCallbacks.PlayerDeletePrefix, '');
            const player = await this.services.repositories.players.findById(playerId);
            if (!player) {
                await this.services.adminUi.replaceWithError(ctx, 'Гравця не знайдено.', createFlowCancelKeyboard(AdminCallbacks.UnconfirmedPlayers));
                return;
            }
            await this.services.adminUi.show(ctx, `🗑 Видалити «${player.displayName}»?\n\nЦе дозволено лише для непідтвердженого профілю без реєстрацій.`, createPlayerDeleteConfirmationKeyboard(player.id));
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerAliasPrefix)) {
            const playerId = callback.replace(AdminCallbacks.PlayerAliasPrefix, '');
            this.services.adminFlow.transition(adminId, 'waiting_player_alias', { playerId });
            await this.services.adminUi.show(ctx, ['🏷 Новий псевдонім', '', 'Надішліть псевдонім одним повідомленням.', 'Наприклад: Саша'].join('\n'), createFlowNavigationKeyboard(`${AdminCallbacks.PlayerPrefix}${playerId}`, AdminCallbacks.Players));
            return;
        }

        if (callback.startsWith(AdminCallbacks.PlayerMergePrefix)) {
            const sourcePlayerId = callback.replace(AdminCallbacks.PlayerMergePrefix, '');
            this.services.adminFlow.transition(adminId, 'waiting_player_merge_target', { sourcePlayerId, playerSelectionAction: 'merge_target' });
            await this.services.adminUi.show(ctx, ['🔀 Обʼєднання гравців', '', 'Надішліть імʼя гравця, якого потрібно залишити.', 'Наприклад: Олександр'].join('\n'), createFlowNavigationKeyboard(`${AdminCallbacks.PlayerPrefix}${sourcePlayerId}`, AdminCallbacks.Players));
            return;
        }

        const playerId = callback
            .replace(
                AdminCallbacks.PlayerPrefix,
                '',
            )
            .replace(':rename', '');

        const player =
            await this.services.repositories.players.findById(
                playerId,
            );

        if (!player) {
            throw new Error(
                `Player ${playerId} not found`,
            );
        }

        this.services.adminFlow.transition(
            adminId,
            'waiting_player_name',
            {
                playerId,
            },
        );

        await this.services.adminUi.show(
            ctx,
            [
                '✏️ Зміна імені',
                '',
                `Зараз: ${player.displayName}`,
                '',
                'Надішліть правильне імʼя',
            ].join('\n'),
            createFlowNavigationKeyboard(`${AdminCallbacks.PlayerPrefix}${player.id}`, AdminCallbacks.Players),
        );
    }

    canHandleText(
        adminId: number,
    ): boolean {
        const state =
            this.services.adminFlow.getState(
                adminId,
            );

        return (
            state === 'waiting_player_name' ||
            state === 'waiting_new_player_name' ||
            state === 'waiting_player_search' ||
            state === 'waiting_player_selection' ||
            state === 'waiting_player_alias' ||
            state === 'waiting_player_merge_target' ||
            state === 'waiting_player_merge_confirmation'
        );
    }

    async handleText(
        ctx: Context,
        text: string,
    ): Promise<void> {
        const adminId = ctx.from?.id;

        if (!adminId) {
            return;
        }

        const state =
            this.services.adminFlow.getState(
                adminId,
            );

        if (state === 'waiting_player_search') {
            const data = this.services.adminFlow.getData(adminId);
            const players = await this.services.players.search(text, 10, { includeInactive: data.includeInactive, unconfirmedOnly: data.playerSearchScope === 'unconfirmed' });
            this.services.adminFlow.transition(adminId, 'waiting_player_selection', { searchQuery: text, playerResultIds: players.map((player) => player.id), playerSelectionAction: data.playerSelectionAction ?? 'open' });
            await this.services.adminUi.show(ctx, [players.length ? `🔎 Результати для «${text}»` : `За запитом «${text}» нічого не знайдено`, '', renderNumbered(players), ...(players.length ? ['', 'Надішліть номер гравця.'] : [])].join('\n'), createPlayerListKeyboard([], data.returnCallback));
            return;
        }

        if (state === 'waiting_player_selection') {
            await this.selectNumberedPlayer(ctx, adminId, text);
            return;
        }

        if (state === 'waiting_player_merge_target') {
            const data = this.services.adminFlow.getData(adminId);
            const players = (await this.services.players.search(text, 10, { includeInactive: true })).filter((player) => player.id !== data.sourcePlayerId);
            this.services.adminFlow.transition(adminId, 'waiting_player_selection', { playerResultIds: players.map((player) => player.id), playerSelectionAction: 'merge_target' });
            await this.services.adminUi.show(ctx, [players.length ? '🔗 Знайдені цільові гравці' : 'Цільового гравця не знайдено', '', renderNumbered(players), ...(players.length ? ['', 'Надішліть номер цільового гравця.'] : [])].join('\n'), createPlayerListKeyboard([], `${AdminCallbacks.PlayerPrefix}${data.sourcePlayerId}`));
            return;
        }

        if (state === 'waiting_player_merge_confirmation') {
            await this.services.adminUi.replaceWithError(ctx, 'Підтвердьте обʼєднання кнопкою або поверніться назад.', createMergePreviewKeyboard(this.services.adminFlow.getData(adminId).sourcePlayerId!, this.services.adminFlow.getData(adminId).targetPlayerId!));
            return;
        }

        if (state === 'waiting_player_alias') {
            const data = this.services.adminFlow.getData(adminId);
            try {
                if (!text.trim()) throw new Error('Псевдонім не може бути порожнім');
                const player = await this.services.players.addAlias(data.playerId!, text);
                this.finishPlayerFlow(adminId);
                await this.services.adminUi.replaceWithSuccess(ctx, `Псевдонім додано.\n\n${renderPlayerCard(player)}`, createPlayerKeyboard(player));
            } catch (error) {
                await this.services.adminUi.replaceWithError(ctx, error instanceof Error ? error.message : 'Не вдалося додати псевдонім', createFlowCancelKeyboard(`${AdminCallbacks.PlayerPrefix}${data.playerId}`));
            }
            return;
        }

        if (
            state ===
            'waiting_new_player_name'
        ) {
            const name = text.trim().replace(/\s+/g, ' ');
            if (name.length < 2 || name.length > 100) {
                await this.services.adminUi.replaceWithError(ctx, 'Імʼя має містити від 2 до 100 символів. Надішліть інше імʼя.', createFlowCancelKeyboard(AdminCallbacks.Players));
                return;
            }
            this.services.adminFlow.setData(adminId, { pendingPlayerName: name });
            const duplicates = await this.services.players?.findLikelyDuplicates(name) ?? [];
            if (duplicates.length) {
                this.services.adminFlow.transition(adminId, 'waiting_player_selection', { pendingPlayerName: name, duplicatePlayerIds: duplicates.map((player) => player.id), playerResultIds: duplicates.map((player) => player.id), playerSelectionAction: 'open' });
                await this.services.adminUi.show(ctx, ['⚠️ Можливі дублікати', '', renderNumbered(duplicates), '', 'Надішліть номер, щоб відкрити наявного гравця, або виберіть «Створити все одно».'].join('\n'), createDuplicateKeyboard());
                return;
            }
            await this.services.adminUi.show(ctx, ['👀 Перевірте дані', '', `Імʼя: ${name}`, '', 'Усе правильно?'].join('\n'), createPlayerPreviewKeyboard());
            return;
        }

        const data =
            this.services.adminFlow.getData(
                adminId,
            );

        if (!data.playerId) {
            throw new Error(
                'Player ID is missing',
            );
        }

        let player;
        try {
            const name = text.trim().replace(/\s+/g, ' ');
            if (name.length < 2 || name.length > 100) throw new Error('invalid');
            const duplicates = await this.services.players.findLikelyDuplicates(name, data.playerId);
            if (duplicates.length) {
                this.services.adminFlow.transition(adminId, 'waiting_player_selection', { pendingPlayerName: name, sourcePlayerId: data.playerId, playerId: data.playerId, playerResultIds: duplicates.map((item) => item.id), playerSelectionAction: 'merge_target' });
                await this.services.adminUi.show(ctx, ['⚠️ Можливі дублікати', '', renderNumbered(duplicates), '', 'Надішліть номер для об’єднання або перейменуйте все одно.'].join('\n'), createRenameDuplicateKeyboard(data.playerId));
                return;
            }
            player = await this.services.players.updateName(data.playerId, name);
        }
        catch (error) {
            await this.services.adminUi.replaceWithError(ctx, 'Вкажіть коректне імʼя довжиною від 2 до 100 символів', createFlowCancelKeyboard(`${AdminCallbacks.PlayerPrefix}${data.playerId}`));
            return;
        }

        await this.publisher.refreshMessagesForPlayer(
            player.id,
        );

        this.finishPlayerFlow(adminId);

        await this.services.adminUi.replaceWithSuccess(
            ctx,
            `Імʼя змінено.\n\n${renderPlayerCard(player)}`,
            createPlayerKeyboard(player),
        );
    }

    private finishPlayerFlow(adminId: number): void {
        const searchQuery = this.services.adminFlow.getData(adminId).searchQuery;
        if (searchQuery !== undefined) {
            this.services.adminFlow.start(adminId, 'waiting_player_search', { searchQuery });
        } else {
            this.services.adminFlow.reset(adminId);
        }
    }

    private async selectNumberedPlayer(ctx: Context, adminId: number, raw: string): Promise<void> {
        const data = this.services.adminFlow.getData(adminId);
        const index = Number(raw.trim()) - 1;
        const ids = data.playerResultIds ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= ids.length) {
            const players = (await Promise.all(ids.map((id) => this.services.repositories.players.findById(id)))).filter((player): player is NonNullable<typeof player> => Boolean(player));
            await this.services.adminUi.replaceWithError(ctx, ['Надішліть номер зі списку.', '', renderNumbered(players)].join('\n'), createPlayerListKeyboard([], data.returnCallback));
            return;
        }
        const player = await this.services.repositories.players.findById(ids[index]);
        if (!player) {
            await this.services.adminUi.replaceWithError(ctx, 'Цей результат уже неактуальний. Повторіть пошук.', createPlayerListKeyboard([], data.returnCallback));
            return;
        }
        if (data.playerSelectionAction === 'confirm') {
            const updated = await this.services.players.setConfirmed(player.id, true);
            this.finishPlayerFlow(adminId);
            await this.services.adminUi.replaceWithSuccess(ctx, `Гравця підтверджено.\n\n${renderPlayerCard(updated)}`, createPlayerKeyboard(updated));
            return;
        }
        if (data.playerSelectionAction === 'edit') {
            this.services.adminFlow.transition(adminId, 'waiting_player_name', { playerId: player.id });
            await this.services.adminUi.show(ctx, `✏️ Зміна імені\n\nЗараз: ${player.displayName}\n\nНадішліть правильне імʼя.`, createFlowCancelKeyboard(data.returnCallback ?? AdminCallbacks.UnconfirmedPlayers));
            return;
        }
        if (data.playerSelectionAction === 'merge_source') {
            this.services.adminFlow.transition(adminId, 'waiting_player_merge_target', {
                sourcePlayerId: player.id,
                playerSelectionAction: 'merge_target',
            });
            await this.services.adminUi.show(ctx, ['🔗 Обʼєднання гравців', '', `Джерело: ${player.displayName}`, 'Надішліть імʼя гравця, якого потрібно залишити.'].join('\n'), createFlowNavigationKeyboard(`${AdminCallbacks.PlayerPrefix}${player.id}`, AdminCallbacks.UnconfirmedPlayers));
            return;
        }
        if (data.playerSelectionAction === 'merge_target') {
            const source = data.sourcePlayerId ? await this.services.repositories.players.findById(data.sourcePlayerId) : undefined;
            if (!source) { await this.services.adminUi.replaceWithError(ctx, 'Початкового гравця не знайдено.', createFlowCancelKeyboard(AdminCallbacks.Players)); return; }
            this.services.adminFlow.transition(adminId, 'waiting_player_merge_confirmation', { targetPlayerId: player.id });
            await this.services.adminUi.show(ctx, ['🔗 Попередній перегляд', '', `Джерело: ${source.displayName}`, `Ціль: ${player.displayName}`, '', 'Telegram-привʼязка, aliases та реєстрації будуть перенесені. Джерело деактивується лише після успішного перенесення.'].join('\n'), createMergePreviewKeyboard(source.id, player.id));
            return;
        }
        this.services.adminFlow.reset(adminId);
        await this.services.adminUi.show(ctx, renderPlayerCard(player), createPlayerKeyboard(player));
    }
}
