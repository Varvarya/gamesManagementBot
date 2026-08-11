import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminCallbacks } from '../bot/admin/callbacks/admin-callbacks';
import { TemplateFlowHandler } from '../bot/admin/flows/template-flow.handler';
import { AdminTemplateHandler } from '../bot/admin/handlers/admin-template.handler';
import { createTemplateDeleteKeyboard, createTemplateKeyboard } from '../bot/admin/keyboards/template.keyboard';
import { PendingRegistrationSelectionStore, REGISTRATION_SELECTION_PREFIX } from '../bot/registration/pending-registration-selection.store';
import { PlayerService } from '../domain/players/player.service';
import { RegistrationCommandParser } from '../domain/trainings/registration-command.parser';
import { RegistrationService } from '../domain/trainings/registration.service';
import { TrainingParticipantsService } from '../domain/trainings/training-participants.service';
import { TrainingService } from '../domain/trainings/training.service';
import { Training } from '../domain/trainings/training.types';
import { TrainingTemplate } from '../domain/templates/template.types';
import { GroupRegistrationHandler } from '../bot/handlers/group-registration.handler';
import { ServicesContext } from '../app/services.context';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { Context } from 'telegraf';

const template: TrainingTemplate = {
    id: 'template-short', clubId: 'club', title: 'Evening', chatId: -100, enabled: true,
    slots: [], placesLimit: 12, minPlayers: 1, publishDaysBefore: 1, publishTime: '12:00',
    createdAt: '', updatedAt: '',
};

test('every visible template card action has exactly one handler and valid callback data', () => {
    const flow = new TemplateFlowHandler({} as never, {} as never);
    const regular = new AdminTemplateHandler({} as never, {} as never);
    const callbacks = [...callbacksOf(createTemplateKeyboard(template)), ...callbacksOf(createTemplateDeleteKeyboard(template.id))];
    for (const callback of callbacks) {
        assert.ok(Buffer.byteLength(callback, 'utf8') <= 64, callback);
        const matches = [flow.canHandleCallback(callback), regular.canHandle(callback)].filter(Boolean).length;
        assert.equal(matches, 1, `${callback} must have exactly one handler`);
    }
    assert.equal(flow.canHandleCallback(`${AdminCallbacks.TemplateEditPrefix}${template.id}`), true);
    assert.equal(regular.canHandle(`${AdminCallbacks.TemplateTogglePrefix}${template.id}`), true);
    assert.equal(regular.canHandle(`${AdminCallbacks.TemplateDeletePrefix}${template.id}`), true);
    assert.equal(regular.canHandle(`${AdminCallbacks.TemplateDeleteConfirmPrefix}${template.id}`), true);
    assert.equal(regular.canHandle(AdminCallbacks.Schedule), true);
});

test('two open trainings select the requested target; removal smart-filters and replies win', async () => {
    const trainings = [makeTraining('a', 101, '10:00', '11:00'), makeTraining('b', 102, '12:00', '13:00')];
    const trainingApi = {
        listRelevantOpenByChatId: async (chatId: number) => trainings.filter((item) => item.chatId === chatId && item.status === 'open'),
        findByMessageId: async (chatId: number, messageId: number) => trainings.find((item) => item.chatId === chatId && item.messageId === messageId),
        isRelevantOpen: (training: Training, chatId: number) => training.chatId === chatId && training.status === 'open',
        getRequired: async (id: string) => structuredClone(trainings.find((item) => item.id === id)!),
        save: async (value: Training) => {
            const index = trainings.findIndex((item) => item.id === value.id);
            trainings[index] = structuredClone(value);
            return structuredClone(value);
        },
    } as unknown as TrainingService;
    const players: Array<{ id: string; telegramUserId: number; displayName: string }> = [];
    const playerApi = {
        findByTelegramId: async (id: number) => players.find((player) => player.telegramUserId === id),
        findOrCreateByTelegramUser: async (user: { id: number; first_name?: string }) => {
            let player = players.find((item) => item.telegramUserId === user.id);
            if (!player) { player = { id: `p${user.id}`, telegramUserId: user.id, displayName: user.first_name ?? String(user.id) }; players.push(player); }
            return { ...player, aliases: [], isConfirmed: false, isActive: true, createdAt: '', updatedAt: '' };
        },
        resolveByStrongName: async () => undefined,
    } as unknown as PlayerService;
    const service = new RegistrationService(playerApi, trainingApi, new TrainingParticipantsService(trainingApi));
    const parser = new RegistrationCommandParser();
    const input = { telegramUser: { id: 7, first_name: 'User' }, chatId: -100, command: parser.parse('+1')! };

    const addResolution = await service.resolveCommand(input);
    assert.equal(addResolution.kind, 'select');
    const hintedInput = { ...input, command: parser.parse('+1 на 12')! };
    const hintedResolution = await service.resolveCommand(hintedInput);
    assert.equal(hintedResolution.kind === 'ready' && hintedResolution.training.id, 'b');
    assert.deepEqual(hintedInput.command.targetNames, []);
    await service.executeCommandAgainstTraining(hintedInput, 'b');
    assert.equal(trainings[0].participants.length, 0);
    assert.equal(trainings[1].participants[0].displayName, 'User');
    assert.deepEqual(players.map((player) => player.displayName), ['User']);

    const removeInput = { ...input, command: parser.parse('-1')! };
    const removeOne = await service.resolveCommand(removeInput);
    assert.equal(removeOne.kind, 'ready');
    assert.equal(removeOne.kind === 'ready' && removeOne.training.id, 'b');

    await service.executeCommandAgainstTraining(input, 'a');
    const removeBoth = await service.resolveCommand(removeInput);
    assert.equal(removeBoth.kind, 'select');

    const reply = await service.resolveCommand({ ...input, replyToMessageId: 102 });
    assert.equal(reply.kind === 'ready' && reply.training.id, 'b');
    const replyRemove = await service.resolveCommand({ ...removeInput, replyToMessageId: 101 });
    assert.equal(replyRemove.kind === 'ready' && replyRemove.training.id, 'a');
});

test('registration selector tokens are short, owner-bound, expiring, and preserve the command', async () => {
    const parser = new RegistrationCommandParser();
    const store = new PendingRegistrationSelectionStore(15);
    const [first, second] = store.create({
        clubId: 'club', chatId: -100, telegramUser: { id: 7, first_name: 'User' },
        command: parser.parse('+3')!, candidateTrainingIds: ['a', 'b'],
    });
    for (const value of [first, second]) assert.ok(Buffer.byteLength(`${REGISTRATION_SELECTION_PREFIX}${value.token}`) <= 64);
    assert.equal(first.command.count, 3);
    assert.deepEqual(first.candidateTrainingIds, ['a', 'b']);
    assert.equal(store.get(`${REGISTRATION_SELECTION_PREFIX}${second.token}`).status, 'active');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(store.get(`${REGISTRATION_SELECTION_PREFIX}${second.token}`).status, 'expired');
});

test('another Telegram user cannot use a registration selector', async () => {
    const store = new PendingRegistrationSelectionStore();
    const pending = store.create({
        clubId: 'club', chatId: -100, telegramUser: { id: 7 }, command: new RegistrationCommandParser().parse('+1')!,
        candidateTrainingIds: ['a'],
    })[0];
    let feedback = '';
    const ctx = {
        from: { id: 8 }, chat: { id: -100 }, callbackQuery: { data: `${REGISTRATION_SELECTION_PREFIX}${pending.token}` },
        answerCbQuery: async (text: string) => { feedback = text; },
    } as unknown as Context;
    const handler = new GroupRegistrationHandler(
        { repositories: { clubId: 'club' } } as unknown as ServicesContext,
        {} as TrainingPublisherService,
        store,
    );
    await handler.handleSelection(ctx, `${REGISTRATION_SELECTION_PREFIX}${pending.token}`);
    assert.equal(feedback, '⚠️ Це меню належить іншому користувачу.');
    assert.equal(store.get(pending.token).status, 'active');
});

function callbacksOf(markup: unknown): string[] {
    const rows = (markup as { reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }).reply_markup.inline_keyboard;
    return rows.flat().flatMap((button) => button.callback_data ? [button.callback_data] : []);
}

function makeTraining(id: string, messageId: number, startTime: string, endTime: string): Training {
    return {
        id, clubId: 'club', chatId: -100, messageId, title: id, date: '2099-08-12', startTime, endTime,
        placesLimit: 12, minPlayers: 1, status: 'open', participants: [], waitlist: [], createdAt: '', updatedAt: '',
    };
}
