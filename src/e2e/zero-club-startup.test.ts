import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context, Telegraf } from 'telegraf';
import { ApplicationContext } from '../app/application.context';
import { ClubRepository } from '../storage/repositories/club.repository';
import { ClubCreationRequestRepository } from '../storage/repositories/club-creation-request.repository';
import { SessionContextService } from '../bot/session/session-context.service';
import { CallbackAuthorizationService } from '../bot/authorization/callback-authorization.service';
import { ClubHealthService } from '../domain/clubs/club-health.service';
import { ClubManagementHandler } from '../bot/handlers/club-management.handler';
import { AdminCallbacks } from '../bot/admin/callbacks/admin-callbacks';

test('fresh DATA_DIR starts with only system storage and zero scheduler jobs without CLUB_NAME', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-zero-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const previousName = process.env.CLUB_NAME;
    delete process.env.CLUB_NAME;
    t.after(() => { if (previousName === undefined) delete process.env.CLUB_NAME; else process.env.CLUB_NAME = previousName; });
    const app = await ApplicationContext.create({ botToken: '1:test-token', dataDir: root, superAdminIds: [99], defaultTimezone: 'Europe/Kyiv' });
    assert.deepEqual(await app.clubs.findAll(), []);
    assert.deepEqual((await readdir(root)).sort(), ['_system']);
    assert.deepEqual((await readdir(path.join(root, '_system'))).sort(), ['club-creation-requests.json', 'clubs.json']);
    (app.bot.telegram as unknown as { getMe: () => Promise<object>; setMyCommands: () => Promise<boolean> }).getMe = async () => ({});
    (app.bot.telegram as unknown as { getMe: () => Promise<object>; setMyCommands: () => Promise<boolean> }).setMyCommands = async () => true;
    (app.bot as unknown as { launch: () => Promise<void> }).launch = async () => undefined;
    await app.start();
    assert.equal(app.clubContexts.hasClubContext('anything'), false);
    assert.deepEqual((await readdir(root)).sort(), ['_system']);
});

test('zero-club Super Admin and normal-user onboarding have actionable empty states', async (t) => {
    const fixture = await createHandlerFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const superCtx = fakeContext(99);
    assert.equal(await fixture.handler.handleStart(superCtx.ctx), true);
    assert.match(superCtx.messages[0].text, /Суперадміністратор[\s\S]*Клубів поки немає/);
    assert.deepEqual(callbacks(superCtx.messages[0].extra), ['superadmin:club:create', AdminCallbacks.ClubRequestList]);

    const userCtx = fakeContext(10);
    await fixture.handler.handleStart(userCtx.ctx);
    assert.match(userCtx.messages[0].text, /ще не належите до жодного клубу/);
    const join = fakeContext(10, 'onboarding:join');
    await fixture.handler.handleCallback(join.ctx);
    assert.match(join.messages[0].text, /Поки що немає доступних клубів/);
    assert.deepEqual(callbacks(join.messages[0].extra), ['onboarding:create', 'onboarding:start']);
});

test('first user request is global and creates no club folder until Super Admin approval', async (t) => {
    const fixture = await createHandlerFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await fixture.handler.handleCallback(fakeContext(10, 'onboarding:create').ctx);
    await fixture.handler.handleMessage(fakeTextContext(10, 'Перший клуб').ctx);
    await fixture.handler.handleCallback(fakeContext(10, AdminCallbacks.ClubRequestConfirm).ctx);
    const request = (await fixture.requests.findPending())[0];
    assert.ok(request);
    assert.deepEqual((await readdir(fixture.root)).sort(), ['_system']);

    fixture.sessions.enterSuperAdmin(99);
    await fixture.handler.handleCallback(fakeContext(99, `${AdminCallbacks.ClubRequestApprovePrefix}${request.shortId}`).ctx);
    const clubs = await fixture.clubs.findAll();
    assert.equal(clubs.length, 1);
    assert.equal((await fixture.requests.findById(request.id))?.status, 'approved');
    assert.ok((await readdir(fixture.root)).includes(clubs[0].slug));
    const authorization = await fixture.clubs.loadAuthorizationContext(clubs[0].id);
    assert.deepEqual(authorization.admins, [{ telegramUserId: 10, role: 'owner' }]);

    const restarted = new ClubRepository(fixture.root);
    assert.equal((await restarted.findAll()).length, 1);
});

test('Super Admin can directly create the first club', async (t) => {
    const fixture = await createHandlerFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    fixture.sessions.enterSuperAdmin(99);
    await fixture.handler.handleCallback(fakeContext(99, 'superadmin:club:create').ctx);
    await fixture.handler.handleMessage(fakeTextContext(99, 'Адмін клуб').ctx);
    await fixture.handler.handleCallback(fakeContext(99, 'club:create:confirm').ctx);
    const club = (await fixture.clubs.findAll())[0];
    assert.ok(club);
    assert.ok((await readdir(fixture.root)).includes(club.slug));
});

async function createHandlerFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-zero-handler-'));
    const clubs = new ClubRepository(root);
    await clubs.findAll();
    const requests = new ClubCreationRequestRepository(path.join(root, '_system', 'club-creation-requests.json'));
    await requests.load();
    const sessions = new SessionContextService();
    const authorization = new CallbackAuthorizationService(clubs, requests, [99], sessions);
    const bot = { telegram: { sendMessage: async () => ({ message_id: 1 }) } } as unknown as Telegraf;
    const handler = new ClubManagementHandler(bot, clubs, requests, [99], authorization, sessions, new ClubHealthService(clubs, root));
    return { root, clubs, requests, sessions, handler };
}

function fakeContext(userId: number, callback?: string) {
    const messages: Array<{ text: string; extra?: unknown }> = [];
    const ctx = {
        from: { id: userId, first_name: `User ${userId}` }, chat: { id: userId, type: 'private' },
        callbackQuery: callback ? { data: callback } : undefined,
        reply: async (text: string, extra?: unknown) => { messages.push({ text, extra }); return { message_id: messages.length }; },
        answerCbQuery: async () => undefined,
    } as unknown as Context;
    return { ctx, messages };
}

function fakeTextContext(userId: number, text: string) {
    const value = fakeContext(userId);
    (value.ctx as unknown as { message: object }).message = { message_id: 1, text };
    return value;
}

function callbacks(extra: unknown): string[] {
    const keyboard = (extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })?.reply_markup?.inline_keyboard ?? [];
    return keyboard.flat().map((button) => button.callback_data).filter((value): value is string => Boolean(value));
}
