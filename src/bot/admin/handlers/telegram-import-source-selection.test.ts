import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, Markup } from 'telegraf';
import {
    createAmbiguousReviewKeyboard,
    createTelegramSourcePickerKeyboard,
    createTelegramImportPreviewKeyboard,
    extractTelegramSourceSelector,
    parseTelegramChatLink,
    TelegramPlayerImportHandler,
} from './telegram-player-import.handler';
import { findAccessibleTelegramGroup } from '../../../domain/telegram-import/telegram-user-connection.manager';
import { TelegramGroupDialog } from '../../../tools/telegram-players-export/telegram-mtproto-loader';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { TelegramPlayerImportSession } from '../../../domain/telegram-import/telegram-player-import.service';
import { findNextUnresolvedCandidate, getImportUiState } from '../../../domain/telegram-import/telegram-player-import.service';
import { GroupRegistrationHandler } from '../../handlers/group-registration.handler';
import { ServicesContext } from '../../../app/services.context';
import { TrainingPublisherService } from '../../../domain/trainings/training-publisher.service';
import { REGISTRATION_SELECTION_PREFIX } from '../../registration/pending-registration-selection.store';

test('chat_shared resolves only the matching native picker request', () => {
    assert.deepEqual(extractTelegramSourceSelector({ chat_shared: { request_id: 42, chat_id: -100123 } }, 42), {
        kind: 'selected', selector: { chatId: '-100123' },
    });
    assert.deepEqual(extractTelegramSourceSelector({ chat_shared: { request_id: 41, chat_id: -100123 } }, 42), { kind: 'wrong_request' });
});

test('forwarded group and channel messages resolve their origin while hidden origins do not', () => {
    assert.deepEqual(extractTelegramSourceSelector({ forward_origin: { type: 'chat', sender_chat: { id: -123 } } }, 1), {
        kind: 'selected', selector: { chatId: '-123' },
    });
    assert.deepEqual(extractTelegramSourceSelector({ forward_origin: { type: 'channel', chat: { id: -100456 } } }, 1), {
        kind: 'selected', selector: { chatId: '-100456' },
    });
    assert.deepEqual(extractTelegramSourceSelector({ forward_origin: { type: 'hidden_user', sender_user_name: 'Hidden' } }, 1), { kind: 'hidden_forward' });
});

test('public and private-message t.me links resolve without fuzzy title matching', () => {
    assert.deepEqual(parseTelegramChatLink('https://t.me/wbc_players/15'), { username: 'wbc_players' });
    assert.deepEqual(parseTelegramChatLink('t.me/c/123456/15'), { chatId: '-100123456' });
    assert.equal(parseTelegramChatLink('https://t.me/+invite-secret'), undefined);
});

test('native picker requests groups and normal flow has no dialog pagination controls', () => {
    const keyboard = createTelegramSourcePickerKeyboard(77).reply_markup;
    const request = keyboard.keyboard[0]?.[0];
    assert.ok(request && typeof request === 'object' && 'request_chat' in request);
    if (typeof request !== 'object' || !('request_chat' in request)) assert.fail('group request button was not rendered');
    assert.equal(request.request_chat.request_id, 77);
    assert.equal(request.request_chat.chat_is_channel, false);
    assert.equal(JSON.stringify(keyboard).includes('Наступ'), false);
    assert.equal(Object.keys(AdminCallbacks).some((key) => key.includes('TelegramDialog')), false);
});

test('successful selection cleanup uses remove_keyboard markup', () => {
    assert.deepEqual(Markup.removeKeyboard().reply_markup, { remove_keyboard: true });
});

test('a group unavailable to the connected MTProto account is not resolved', () => {
    const groups = [{ id: '-1001', title: 'Allowed', entity: {} }] as TelegramGroupDialog[];
    assert.equal(findAccessibleTelegramGroup(groups, '-1002'), undefined);
    assert.equal(findAccessibleTelegramGroup(groups, '-1001'), groups[0]);
});

test('every ambiguous review callback is short and routed by exactly the Telegram import handler contract', () => {
    const markup = createAmbiguousReviewKeyboard('Ab31cd', { candidateToken: 'X91p', position: 1, total: 4, telegramDisplayName: 'Alex', suggestedDisplayName: 'Alex', players: [
        { token: 'P1', id: 'player-a', displayName: 'Alex A' }, { token: 'P2', id: 'player-b', displayName: 'Alex B' },
    ] }).reply_markup;
    const callbacks = markup.inline_keyboard.flat().flatMap((button) => 'callback_data' in button ? [button.callback_data] : []);
    assert.deepEqual(callbacks, ['tir:m:Ab31cd:X91p:P1', 'tir:m:Ab31cd:X91p:P2', 'tir:n:Ab31cd:X91p', 'tir:s:Ab31cd:X91p', 'tir:b:Ab31cd']);
    for (const callback of callbacks) {
        assert.ok(Buffer.byteLength(callback, 'utf8') <= 64);
        assert.equal(TelegramPlayerImportHandler.prototype.canHandle.call({} as TelegramPlayerImportHandler, callback), true);
    }
    assert.equal(TelegramPlayerImportHandler.prototype.canHandle.call({} as TelegramPlayerImportHandler, 'tir:a:Ab31cd'), true, 'main Review opens the next candidate');
    assert.equal(TelegramPlayerImportHandler.prototype.canHandle.call({} as TelegramPlayerImportHandler, 'tir:b:Ab31cd'), true, 'candidate Back opens the preview');
    assert.equal(TelegramPlayerImportHandler.prototype.canHandle.call({} as TelegramPlayerImportHandler, `${REGISTRATION_SELECTION_PREFIX}Reg123`), false, 'import callbacks never shadow registration selection');
});

test('blocked preview Review has one direct route to the first ambiguous candidate and no summary route', () => {
    const session = { id: 'Ab31cd', state: 'reviewing', canCommit: false, possibleDuplicateCount: 0, reviewCount: 0, blockedCount: 4, importCandidates: [{ token: 'C1', candidate: {} }], reviewCandidates: [], decisions: {}, plan: { newCount: 1, updateCount: 0, conflicts: [{ type: 'ambiguous_exact_match', rows: [2], candidatePlayerIds: ['p'] }] } } as unknown as TelegramPlayerImportSession;
    const callbacks = createTelegramImportPreviewKeyboard(session, 4).reply_markup.inline_keyboard.flat().flatMap((button) => 'callback_data' in button ? [button.callback_data] : []);
    assert.deepEqual(callbacks, ['tir:a:Ab31cd', 'pt:x:Ab31cd']);
    assert.equal(callbacks.some((callback) => callback.startsWith('pt:rv:')), false);
    assert.equal(TelegramPlayerImportHandler.prototype.canHandle.call({} as TelegramPlayerImportHandler, callbacks[0]), true);
});

test('ready preview exposes Import only after all blockers are resolved', () => {
    const blocked = { id: 'Ab31cd', state: 'reviewing', canCommit: false, possibleDuplicateCount: 0, reviewCount: 0, blockedCount: 4, importCandidates: [{ token: 'C1', candidate: {} }], reviewCandidates: [], decisions: {}, plan: { newCount: 1, updateCount: 0, conflicts: [{ type: 'ambiguous_exact_match', rows: [2], candidatePlayerIds: ['p'] }] } } as unknown as TelegramPlayerImportSession;
    const ready = { ...blocked, state: 'ready', blockedCount: 0, canCommit: true, plan: { newCount: 1, updateCount: 0, conflicts: [] } } as unknown as TelegramPlayerImportSession;
    const callbacks = (session: TelegramPlayerImportSession, count: number) => createTelegramImportPreviewKeyboard(session, count).reply_markup.inline_keyboard.flat().flatMap((button) => 'callback_data' in button ? [button.callback_data] : []);
    assert.equal(callbacks(blocked, 4).some((value) => value.startsWith(AdminCallbacks.PlayerTelegramImportConfirmPrefix)), false);
    assert.equal(callbacks(ready, 0).some((value) => value.startsWith(AdminCallbacks.PlayerTelegramImportConfirmPrefix)), true);
});

test('production-shaped reviewing state derives Review from the next candidate, not conflict metadata flags', () => {
    const candidate = { token: 'candidate1', candidate: { telegramUserId: 101, telegramDisplayName: 'Олександр', suggestedDisplayName: 'Олександр', aliases: [], isContact: false, needsReview: false } };
    const session = { id: 'Prod17', clubId: 'club-a', requestedBy: 10, state: 'reviewing', canCommit: false, blockedCount: 4, blockingTypes: ['AMBIGUOUS_MATCH'], possibleDuplicateCount: 0, reviewCount: 0, skippedCount: 1, existingCount: 5, candidates: Array(178).fill(candidate.candidate), importCandidates: [candidate], reviewCandidates: [], decisions: {}, plan: { newCount: 164, updateCount: 0, unchangedCount: 0, blockedCount: 4, canCommit: false, errors: [], errorCount: 0, conflicts: [{ type: 'ambiguous_exact_match', rows: [2], message: 'ambiguous' }], conflictCount: 4 } } as unknown as TelegramPlayerImportSession;
    assert.deepEqual(getImportUiState(session).availableActions, ['review', 'cancel']);
    assert.deepEqual(findNextUnresolvedCandidate(session), { type: 'AMBIGUOUS_MATCH', candidateToken: 'candidate1', conflictIndex: 0 });
    const callbacks = createTelegramImportPreviewKeyboard(session, 4).reply_markup.inline_keyboard.flat().flatMap((button) => 'callback_data' in button ? [button.callback_data] : []);
    assert.deepEqual(callbacks, ['tir:a:Prod17', 'pt:x:Prod17']);
});

test('normalized import UI state matrix never hides a forward action for resolvable non-terminal states', () => {
    const base = { id: 'Matrix', state: 'preview', canCommit: false, blockedCount: 0, possibleDuplicateCount: 0, reviewCount: 0, candidates: [], importCandidates: [], reviewCandidates: [], decisions: {}, plan: { newCount: 0, updateCount: 0, blockedCount: 0, canCommit: true, conflicts: [] } } as unknown as TelegramPlayerImportSession;
    const candidate = { token: 'soft1', candidate: { telegramUserId: 1, telegramDisplayName: 'Name', suggestedDisplayName: 'Name', aliases: [], isContact: false, needsReview: false }, candidatePlayerIds: [] };
    const cases: Array<[string, TelegramPlayerImportSession, string[]]> = [
        ['preview without blockers', base, ['cancel']],
        ['possible duplicate', { ...base, state: 'reviewing', blockedCount: 1, possibleDuplicateCount: 1, reviewCandidates: [{ ...candidate, type: 'POSSIBLE_DUPLICATE' }] }, ['review', 'skip_problematic', 'cancel']],
        ['needs review', { ...base, state: 'reviewing', blockedCount: 1, reviewCount: 1, reviewCandidates: [{ ...candidate, type: 'NEEDS_REVIEW' }] }, ['review', 'skip_problematic', 'cancel']],
        ['ambiguous', { ...base, state: 'reviewing', blockedCount: 1, importCandidates: [candidate], plan: { ...base.plan, blockedCount: 1, canCommit: false, conflicts: [{ type: 'ambiguous_exact_match', rows: [2], message: 'ambiguous' }] } }, ['review', 'cancel']],
        ['mixed', { ...base, state: 'reviewing', blockedCount: 2, reviewCount: 1, reviewCandidates: [{ ...candidate, type: 'NEEDS_REVIEW' }], importCandidates: [{ ...candidate, token: 'hard1' }], plan: { ...base.plan, blockedCount: 1, canCommit: false, conflicts: [{ type: 'ambiguous_exact_match', rows: [2], message: 'ambiguous' }] } }, ['review', 'skip_problematic', 'cancel']],
        ['ready', { ...base, state: 'ready', canCommit: true, plan: { ...base.plan, newCount: 1 } }, ['commit', 'cancel']],
        ['committing', { ...base, state: 'committing' }, ['cancel']],
        ['completed', { ...base, state: 'completed' }, ['cancel']],
        ['cancelled', { ...base, state: 'cancelled' }, ['cancel']],
        ['expired', { ...base, state: 'expired' }, ['cancel']],
        ['unrecoverable error', { ...base, state: 'failed', blockedCount: 1, plan: { ...base.plan, blockedCount: 1, canCommit: false, errors: [{ rowNumber: 2, field: 'displayName', message: 'invalid' }] } }, ['cancel']],
    ];
    for (const [name, session, expected] of cases) assert.deepEqual(getImportUiState(session).availableActions, expected, name);
});

test('private Telegram import input state never consumes group registration messages', async () => {
    const training = { id: 'training-a', clubId: 'club-a', chatId: -100, title: 'Training', date: '2099-01-01', startTime: '18:00', endTime: '20:00', placesLimit: 12, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '', updatedAt: '' };
    const flow = { getState: () => 'waiting_telegram_import_name' };
    const importHandler = new TelegramPlayerImportHandler(
        { adminFlow: flow, repositories: { clubId: 'club-a' } } as unknown as ServicesContext,
        {} as never, {} as never, {} as never, [],
    );
    let registrations = 0;
    const registration = {
        resolveCommand: async () => ({ kind: 'ready' as const, training }),
        executeCommandAgainstTraining: async () => { registrations++; return [{ training }]; },
    };
    const groupHandler = new GroupRegistrationHandler(
        { repositories: { clubId: 'club-a' }, registration } as unknown as ServicesContext,
        { refreshMessage: async () => undefined } as unknown as TrainingPublisherService,
    );
    const groupContext = (userId: number, text: string, updateId: number) => ({
        from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' },
        message: { message_id: updateId, text, from: { id: userId, first_name: `Player ${userId}` }, chat: { id: -100, type: 'supergroup' } },
        update: { update_id: updateId }, reply: async () => undefined,
    } as unknown as Context);
    for (const ctx of [groupContext(20, '+1', 101), groupContext(20, '-1', 102), groupContext(21, '+2', 103)]) {
        assert.equal(await importHandler.handleMessage(ctx), false);
        await groupHandler.handle(ctx);
    }
    assert.equal(registrations, 3);
    assert.equal(flow.getState(), 'waiting_telegram_import_name', 'private import state remains intact');
});
