import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { Player } from '../../../domain/players/player.types';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createKnownPlayersKeyboard, createNewPlayersKeyboard, createPlayerBrowseKeyboard, createPlayerKeyboard, createPlayerListKeyboard, createPlayersKeyboard } from '../keyboards/player.keyboard';
import { renderPlayerCard } from '../ui/admin-formatters';

export class AdminPlayerHandler {
    constructor(private readonly services: ServicesContext) {}

    canHandle(callback: string): boolean {
        return callback === AdminCallbacks.Players || callback === AdminCallbacks.UnconfirmedPlayers || callback === AdminCallbacks.AllPlayers || callback === AdminCallbacks.KnownPlayers || callback === AdminCallbacks.InactivePlayers || callback === AdminCallbacks.PlayerShowFirst || callback === AdminCallbacks.PlayerBrowseNext || callback === AdminCallbacks.PlayerBrowsePrevious || callback.startsWith(AdminCallbacks.PlayerPrefix);
    }

    async handle(ctx: Context, callback: string): Promise<void> {
        if (callback === AdminCallbacks.Players) { if (ctx.from) this.services.adminFlow.finish(ctx.from.id); await this.showPlayers(ctx); return; }
        if (callback === AdminCallbacks.UnconfirmedPlayers) { await this.showUnconfirmed(ctx); return; }
        if (callback === AdminCallbacks.KnownPlayers || callback === AdminCallbacks.AllPlayers) { await this.showBrowse(ctx, 0, 'active'); return; }
        if (callback === AdminCallbacks.InactivePlayers) { await this.showInactive(ctx); return; }
        if (callback === AdminCallbacks.PlayerBrowseNext || callback === AdminCallbacks.PlayerBrowsePrevious) {
            const data = ctx.from ? this.services.adminFlow.getData(ctx.from.id) : {};
            const delta = callback === AdminCallbacks.PlayerBrowseNext ? 1 : -1;
            await this.showBrowse(ctx, Math.max(0, (data.playerBrowsePage ?? 0) + delta), data.playerBrowseScope ?? 'active');
            return;
        }
        if (callback === AdminCallbacks.PlayerShowFirst) { await this.showFirstKnown(ctx); return; }
        await this.showPlayer(ctx, callback.replace(AdminCallbacks.PlayerPrefix, ''));
    }

    async showPlayers(ctx: Context): Promise<void> {
        const all = await this.services.repositories.players.list();
        const fresh = all.filter((player) => !player.isConfirmed && player.isActive).length;
        const inactive = all.filter((player) => !player.isActive).length;
        const active = all.length - inactive;
        await this.services.adminUi.show(ctx, ['👥 Гравці', '', `Всього: ${all.length}`, `Активних: ${active}`, `Нових: ${fresh}`, `Неактивних: ${inactive}`, '', 'Що ви хочете зробити?'].join('\n'), createPlayersKeyboard(fresh));
    }

    async showUnconfirmed(ctx: Context): Promise<void> {
        const players = (await this.services.repositories.players.listUnconfirmed()).slice(0, 10);
        this.beginSelection(ctx, players, 'open', AdminCallbacks.UnconfirmedPlayers);
        await this.services.adminUi.show(ctx, ['🆕 Нові гравці', '', `Усього: ${(await this.services.repositories.players.listUnconfirmed()).length}`, '', renderNumbered(players), ...(players.length === 10 ? ['', 'Показано перші 10. Скористайтеся пошуком для інших.'] : [])].join('\n'), createNewPlayersKeyboard());
    }

    async showKnown(ctx: Context): Promise<void> {
        const all = await this.services.repositories.players.list();
        const known = all.filter((player) => player.isConfirmed && player.isActive);
        const recent = [...known].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
        if (ctx.from) this.services.adminFlow.start(ctx.from.id, 'waiting_player_search', { includeInactive: false, returnCallback: AdminCallbacks.KnownPlayers });
        await this.services.adminUi.show(ctx, ['✅ Відомі гравці', '', `Усього: ${known.length}`, 'Скористайтеся пошуком, щоб знайти гравця.', ...(recent.length ? ['', 'Нещодавно активні:', renderNumbered(recent)] : [])].join('\n'), createKnownPlayersKeyboard(false));
    }

    async showInactive(ctx: Context): Promise<void> {
        await this.showBrowse(ctx, 0, 'inactive');
    }

    async showBrowse(ctx: Context, requestedPage: number, scope: 'active' | 'inactive'): Promise<void> {
        const pageSize = 25;
        const all = (await this.services.repositories.players.list())
            .filter((player) => scope === 'active' ? player.isActive && player.isConfirmed : !player.isActive)
            .sort((a, b) => a.displayName.localeCompare(b.displayName, 'uk'));
        const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
        const page = Math.min(requestedPage, totalPages - 1);
        const players = all.slice(page * pageSize, (page + 1) * pageSize);
        if (ctx.from) this.services.adminFlow.start(ctx.from.id, 'waiting_player_selection', {
            playerResultIds: players.map((player) => player.id), playerSelectionAction: 'open',
            playerBrowsePage: page, playerBrowseScope: scope, includeInactive: scope === 'inactive',
            returnCallback: scope === 'inactive' ? AdminCallbacks.InactivePlayers : AdminCallbacks.AllPlayers,
        });
        await this.services.adminUi.show(ctx, [scope === 'inactive' ? '🔴 Неактивні гравці' : '👥 Перегляд гравців', '', `Усього: ${all.length} · Сторінка ${page + 1}/${totalPages}`, '', renderNumbered(players), '', 'Надішліть номер, щоб відкрити картку.'].join('\n'), createPlayerBrowseKeyboard(page, totalPages));
    }

    async showFirstKnown(ctx: Context): Promise<void> {
        const known = (await this.services.repositories.players.list()).filter((player) => player.isConfirmed && player.isActive).sort((a, b) => a.displayName.localeCompare(b.displayName, 'uk')).slice(0, 10);
        this.beginSelection(ctx, known, 'open', AdminCallbacks.KnownPlayers);
        await this.services.adminUi.show(ctx, ['📋 Перші відомі гравці', '', renderNumbered(known), '', 'Надішліть номер, щоб відкрити картку.'].join('\n'), createPlayerListKeyboard([], AdminCallbacks.KnownPlayers));
    }

    async showPlayer(ctx: Context, playerId: string): Promise<void> {
        const player = await this.services.repositories.players.findById(playerId);
        if (!player) { await this.services.adminUi.replaceWithError(ctx, 'Гравця не знайдено. Поверніться до списку та повторіть пошук.', createPlayerListKeyboard([])); return; }
        if (ctx.from) this.services.adminFlow.reset(ctx.from.id);
        const trainings = await this.services.repositories.trainings.list();
        const registrations = trainings.filter((training) => [...training.participants, ...training.waitlist].some((entry) => entry.playerId === player.id));
        const current = registrations.filter((training) => ['draft', 'open', 'closed'].includes(training.status));
        await this.services.adminUi.show(ctx, renderPlayerCard(player, { currentTrainings: current, registrationHistory: registrations }), createPlayerKeyboard(player));
    }

    private beginSelection(ctx: Context, players: Player[], action: 'open' | 'confirm' | 'edit', returnCallback: string, includeInactive = false): void {
        if (ctx.from) this.services.adminFlow.start(ctx.from.id, 'waiting_player_selection', { playerResultIds: players.map((player) => player.id), playerSelectionAction: action, returnCallback, includeInactive });
    }
}

export function renderNumbered(players: Player[]): string {
    return players.length ? players.map((player, index) => `${index + 1}. ${player.displayName}`).join('\n') : '—';
}
