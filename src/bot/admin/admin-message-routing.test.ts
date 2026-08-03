import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { AdminTextRouter, MessageFlowHandler, TextFlowHandler } from './admin-text-router';
import { AdminFlowService } from './flows/admin-flow.service';
import { ADMIN_FLOW_STATES, AdminFlowState } from './flows/admin-flow.types';
import { TemplateFlowHandler } from './flows/template-flow.handler';
import { AdminChatHandler } from './handlers/admin-chat.handler';
import { AdminCallbacks } from './callbacks/admin-callbacks';
import { TemplateSchedulerService } from '../../domain/templates/template-scheduler.service';
import { PlayerFlowHandler } from './flows/player-flow.handler';
import { TrainingFlowHandler } from './flows/training-flow.handler';
import { SettingsFlowHandler } from './flows/settings-flow.handler';
import { AdminSettingsHandler } from './handlers/admin-settings.handler';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';
import { SuperAdminConfigHandler } from '../handlers/super-admin-config.handler';
import { SuperAdminConfigService } from '../../domain/config/super-admin-config.service';

function context(message: object): Context {
    return { chat: { id: 1, type: 'private' }, from: { id: 1 }, message, reply: async () => ({}) } as unknown as Context;
}

function coverageHandlers(excluded: readonly AdminFlowState[] = []): { messages: MessageFlowHandler[]; texts: TextFlowHandler[] } {
    const states = ADMIN_FLOW_STATES.filter((state) => state !== 'idle' && !excluded.includes(state));
    return {
        messages: [],
        texts: [{ textStates: states, canHandleText: () => false, handleText: async () => undefined }],
    };
}

function baseServices(adminFlow: AdminFlowService, show: (text: string) => void): ServicesContext {
    return {
        adminFlow,
        adminUi: {
            trackUserMessage: () => undefined,
            show: async (_ctx: Context, text: string) => { show(text); },
            notice: async (ctx: Context, text: string) => { await ctx.reply(text); },
            replaceWithError: async (_ctx: Context, text: string) => { show(text); },
            replaceWithSuccess: async (_ctx: Context, text: string) => { show(text); },
        },
        repositories: { settings: { get: async () => ({ admins: [{ telegramUserId: 1 }] }) } },
    } as unknown as ServicesContext;
}

test('Add Chat callback routes the next manual text message to the same handler and confirms successfully', async () => {
    const flow = new AdminFlowService();
    let rendered = '';
    let saved = false;
    const services = baseServices(flow, (text) => { rendered = text; });
    (services as any).chats = {
        upsert: async (input: object) => { saved = true; return { ...input, enabled: true }; },
    };
    const handler = new AdminChatHandler(services);
    const coverage = coverageHandlers(handler.messageStates);
    const router = new AdminTextRouter(services, [handler, ...coverage.messages], coverage.texts);

    await handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.AddChat);
    assert.equal(flow.getState(1), 'waiting_chat_data');
    await router.handle(context({ text: 'Основна група\n-1001234567890' }));
    assert.match(rendered, /Перевірте дані/);
    assert.equal(flow.getData(1).pendingChatId, -1001234567890);
    await handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.ConfirmAddChat);
    assert.equal(saved, true);
    assert.equal(flow.getState(1), 'idle');
});

test('Add Chat callback routes a forwarded supergroup message to preview', async () => {
    const flow = new AdminFlowService();
    let rendered = '';
    const services = baseServices(flow, (text) => { rendered = text; });
    const handler = new AdminChatHandler(services);
    const coverage = coverageHandlers(handler.messageStates);
    const router = new AdminTextRouter(services, [handler], coverage.texts);

    await handler.handle({ from: { id: 1 } } as Context, AdminCallbacks.AddChat);
    await router.handle(context({ forward_origin: { type: 'chat', sender_chat: { id: -10077, title: 'Forwarded group', type: 'supergroup' } } }));
    assert.match(rendered, /Forwarded group/);
    assert.equal(flow.getData(1).pendingChatId, -10077);
    assert.equal(flow.getState(1), 'waiting_chat_data');
});

test('create and edit template callbacks route subsequent text to TemplateFlowHandler', async () => {
    const flow = new AdminFlowService();
    let rendered = '';
    const services = baseServices(flow, (text) => { rendered = text; });
    (services as any).chats = {
        getEnabled: async () => [{ id: -1, name: 'Chat', enabled: true }],
        getById: async () => ({ id: -1, name: 'Chat', enabled: true }),
    };
    (services as any).templates = {
        getRequired: async () => ({ id: 't', clubId: 'c', chatId: -1, title: 'Old', placesLimit: 10, minPlayers: 5, publishDaysBefore: 1, publishTime: '12:00', slots: [{ id: 's', dayOfWeek: 1, startTime: '18:00', endTime: '19:00', enabled: true }] }),
    };
    const handler = new TemplateFlowHandler(services, {} as TemplateSchedulerService);
    const coverage = coverageHandlers([...handler.textStates, ...handler.callbackStates]);
    const router = new AdminTextRouter(services, coverage.messages, [handler, ...coverage.texts]);
    const input = 'Назва: Нова назва\nПн 18:00-19:00\n10\n5\n1\n12:00';

    await handler.handleCallback({ from: { id: 1 } } as Context, AdminCallbacks.CreateTemplate);
    await router.handle(context({ text: input }));
    assert.equal(flow.getState(1), 'waiting_template_chat_selection');
    assert.equal(flow.getData(1).pendingTemplate?.title, 'Нова назва');

    await handler.handleCallback({ from: { id: 1 } } as Context, `${AdminCallbacks.TemplateEditPrefix}t`);
    await router.handle(context({ text: input }));
    assert.equal(flow.getState(1), 'waiting_template_edit_input');
    assert.match(rendered, /Chat/);
});

test('non-text message during a text-only flow is reported without resetting state', async () => {
    const flow = new AdminFlowService();
    flow.start(1, 'waiting_player_name', { playerId: 'p' });
    let reply = '';
    const services = baseServices(flow, () => undefined);
    const coverage = coverageHandlers();
    const router = new AdminTextRouter(services, [], coverage.texts);
    const ctx = context({ photo: [{ file_id: 'photo' }] });
    (ctx as any).reply = async (text: string) => { reply = text; };
    await router.handle(ctx);
    assert.equal(flow.getState(1), 'waiting_player_name');
    assert.match(reply, /текстове повідомлення/);
});

test('Create Player callback routes name text to player preview', async () => {
    const flow = new AdminFlowService();
    let rendered = '';
    const services = baseServices(flow, (text) => { rendered = text; });
    const handler = new PlayerFlowHandler(services, {} as TrainingPublisherService);
    const coverage = coverageHandlers(handler.textStates);
    const router = new AdminTextRouter(services, [], [handler, ...coverage.texts]);
    await handler.handleCallback({ from: { id: 1 } } as Context, AdminCallbacks.CreatePlayer);
    await router.handle(context({ text: 'Новий Гравець' }));
    assert.equal(flow.getData(1).pendingPlayerName, 'Новий Гравець');
    assert.match(rendered, /Перевірте дані/);
});

test('training add and remove callbacks route search text to TrainingFlowHandler', async () => {
    const flow = new AdminFlowService();
    let rendered = '';
    const services = baseServices(flow, (text) => { rendered = text; });
    const players = [{ id: 'p1', displayName: 'Alex One', aliases: [], isConfirmed: true, isActive: true }, { id: 'p2', displayName: 'Alex Two', aliases: [], isConfirmed: true, isActive: true }];
    (services as any).players = { search: async () => players };
    (services as any).trainings = { getRequired: async () => ({ participants: players.map((player) => ({ playerId: player.id })), waitlist: [] }) };
    const handler = new TrainingFlowHandler(services, {} as TrainingPublisherService);
    const coverage = coverageHandlers(handler.textStates);
    const router = new AdminTextRouter(services, [], [handler, ...coverage.texts]);

    await handler.handleCallback({ from: { id: 1 } } as Context, `${AdminCallbacks.TrainingAddPlayerPrefix}training`);
    await router.handle(context({ text: 'Alex' }));
    assert.match(rendered, /Знайдено кілька гравців/);
    assert.equal(flow.getState(1), 'waiting_training_add_player');

    await handler.handleCallback({ from: { id: 1 } } as Context, `${AdminCallbacks.TrainingRemovePlayerPrefix}training`);
    await router.handle(context({ text: 'Alex' }));
    assert.match(rendered, /Знайдено кілька гравців/);
    assert.equal(flow.getState(1), 'waiting_training_remove_player');
});

test('settings callback routes the next text value and finishes only after success', async () => {
    const flow = new AdminFlowService();
    let updated = '';
    const services = baseServices(flow, () => undefined);
    (services as any).settings = {
        update: async (_field: string, value: string) => { updated = value; },
        get: async () => ({ title: updated, timezone: 'Europe/Kyiv', defaultPlacesLimit: 10, defaultMinPlayers: 5, defaultPublishDaysBefore: 1, defaultPublishTime: '12:00', cancelCheckHoursBefore: 4, cleanChatMode: false, admins: [] }),
    };
    const settingsHandler = new AdminSettingsHandler(services, { restore: async () => undefined } as any, { list: async () => [] } as any);
    const flowHandler = new SettingsFlowHandler(services, settingsHandler);
    const coverage = coverageHandlers([...flowHandler.textStates, ...flowHandler.messageStates]);
    const router = new AdminTextRouter(services, [flowHandler], [flowHandler, ...coverage.texts]);
    await settingsHandler.handle({ from: { id: 1 } } as Context, `${AdminCallbacks.SettingsEditPrefix}title`);
    await router.handle(context({ text: 'Новий клуб' }));
    assert.equal(updated, 'Новий клуб');
    assert.equal(flow.getState(1), 'idle');
});

test('config import state is consumed by the generic message router', async () => {
    const flow = new AdminFlowService();
    const services = baseServices(flow, () => undefined);
    const config = { schemaVersion: 1, data: { settings: {}, chats: [], players: [], templates: [] } };
    const configService = {
        parseImportJson: () => config,
        previewImport: async () => ({ mode: 'snapshot', settingsChanged: false, chats: { current: 0, incoming: 0, added: 0, updated: 0, removed: 0 }, players: { current: 0, incoming: 0, added: 0, updated: 0, removed: 0 }, templates: { current: 0, incoming: 0, added: 0, updated: 0, removed: 0 } }),
    } as unknown as SuperAdminConfigService;
    const handler = new SuperAdminConfigHandler(services, configService, [1]);
    const coverage = coverageHandlers(handler.messageStates);
    const router = new AdminTextRouter(services, [handler], coverage.texts, [1]);
    const startCtx = context({ text: '/import' });
    await handler.startImport(startCtx);
    await router.handle(context({ text: '{}' }));
    assert.deepEqual(flow.getData(1).pendingImport, config);
    assert.equal(flow.getState(1), 'waiting_config_import');
});

test('startup validation rejects an orphaned waiting state', () => {
    const services = baseServices(new AdminFlowService(), () => undefined);
    assert.throws(() => new AdminTextRouter(services, [], []), /Orphaned admin flow states/);
});
