import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { Player } from '../../domain/players/player.types';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';
import { PlayerFlowHandler } from './flows/player-flow.handler';
import { AdminFlowService } from './flows/admin-flow.service';
import { AdminPlayerHandler } from './handlers/admin-player.handler';
import { AdminCallbacks } from './callbacks/admin-callbacks';

const player = (id: string, name: string, confirmed: boolean, active = true): Player => ({ id, displayName: name, aliases: [], isConfirmed: confirmed, isActive: active, createdAt: '', updatedAt: '' });

function harness(players: Player[]) {
    let text = ''; let keyboard: any;
    const flow = new AdminFlowService();
    const services = {
        adminFlow: flow,
        repositories: { players: { list: async () => players, listUnconfirmed: async () => players.filter((item) => !item.isConfirmed), findById: async (id: string) => players.find((item) => item.id === id) } },
        players: { search: async () => players.slice(0, 10), setConfirmed: async (id: string, value: boolean) => { const found = players.find((item) => item.id === id)!; found.isConfirmed = value; return found; } },
        adminUi: { show: async (_ctx: Context, value: string, markup: any) => { text = value; keyboard = markup; }, replaceWithError: async (_ctx: Context, value: string, markup: any) => { text = value; keyboard = markup; }, replaceWithSuccess: async (_ctx: Context, value: string, markup: any) => { text = value; keyboard = markup; } },
    } as unknown as ServicesContext;
    return { services, flow, handler: new AdminPlayerHandler(services), getText: () => text, labels: () => keyboard.reply_markup.inline_keyboard.flat().map((button: any) => button.text) };
}

test('main Players screen shows counts and no player entity buttons', async () => {
    const h = harness([player('new', 'Нова', false), player('known', 'Відома', true), player('off', 'Неактивна', true, false)]);
    await h.handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.Players);
    assert.match(h.getText(), /Усього гравців: 3/); assert.match(h.getText(), /Очікують підтвердження: 1/); assert.match(h.getText(), /Неактивні: 1/);
    assert.deepEqual(h.labels(), ['🔎 Знайти гравця', '➕ Додати гравця', '🆕 Очікують підтвердження', '👥 Переглянути гравців', '🔴 Неактивні гравці', '◀️ Назад']);
    assert.ok(!h.labels().some((label: string) => ['Нова', 'Відома', 'Неактивна'].some((name) => label.includes(name))));
});

test('new players are a numbered text list without entity buttons', async () => {
    const h = harness([player('1', 'Варвара', false), player('2', 'Ірина', false)]);
    await h.handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.UnconfirmedPlayers);
    assert.match(h.getText(), /1\. Варвара\n2\. Ірина/);
    assert.ok(!h.labels().some((label: string) => label.includes('Варвара') || label.includes('Ірина')));
    assert.equal(h.flow.getState(1), 'waiting_player_selection');
});

test('inactive section reports the full count while rendering at most ten rows', async () => {
    const h = harness(Array.from({ length: 12 }, (_, index) => player(String(index), `Неактивна ${index}`, true, false)));
    await h.handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.InactivePlayers);
    assert.match(h.getText(), /Усього: 12/);
    assert.match(h.getText(), /12\. Неактивна/);
});

test('browse paginates text results without player callback buttons', async () => {
    const h = harness(Array.from({ length: 60 }, (_, index) => player(String(index), `Гравець ${String(index).padStart(2, '0')}`, true)));
    await h.handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.AllPlayers);
    assert.match(h.getText(), /Сторінка 1\/3/);
    assert.equal(h.flow.getData(1).playerResultIds?.length, 25);
    assert.ok(!h.labels().some((label: string) => label.includes('Гравець')));
    assert.ok(h.labels().includes('Наступна ➡️'));

    await h.handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.PlayerBrowseNext);
    assert.match(h.getText(), /Сторінка 2\/3/);
    assert.ok(h.labels().includes('⬅️ Попередня'));
});

test('merge duplicates selects a source by number and then asks for the target', async () => {
    const h = harness([player('1', 'Дублікат', false)]);
    const flowHandler = new PlayerFlowHandler(h.services, {} as TrainingPublisherService);
    await flowHandler.handleCallback({ from: { id: 1 } } as Context, AdminCallbacks.PlayerNewMerge);
    assert.equal(h.flow.getData(1).playerSelectionAction, 'merge_source');

    await flowHandler.handleText({ from: { id: 1 } } as Context, '1');
    assert.equal(h.flow.getState(1), 'waiting_player_merge_target');
    assert.equal(h.flow.getData(1).sourcePlayerId, '1');
    assert.match(h.getText(), /Джерело: Дублікат/);
});

test('numeric selection opens one card and invalid selection preserves results and state', async () => {
    const h = harness([player('1', 'Варвара', true), player('2', 'Ірина', true)]);
    h.flow.start(1, 'waiting_player_selection', { playerResultIds: ['1', '2'], playerSelectionAction: 'open' });
    const flowHandler = new PlayerFlowHandler(h.services, {} as TrainingPublisherService);
    await flowHandler.handleText({ from: { id: 1 } } as Context, '9');
    assert.equal(h.flow.getState(1), 'waiting_player_selection'); assert.match(h.getText(), /1\. Варвара/);
    await flowHandler.handleText({ from: { id: 1 } } as Context, '2');
    assert.match(h.getText(), /👤 Ірина/); assert.equal(h.flow.getState(1), 'idle');
});

test('all declared player waiting states have a text consumer', () => {
    const h = harness([]);
    const handler = new PlayerFlowHandler(h.services, {} as TrainingPublisherService);
    for (const state of ['waiting_player_search', 'waiting_player_selection', 'waiting_player_name', 'waiting_new_player_name', 'waiting_player_alias', 'waiting_player_merge_target', 'waiting_player_merge_confirmation'] as const) {
        h.flow.start(1, state);
        assert.equal(handler.canHandleText(1), true, state);
    }
});
