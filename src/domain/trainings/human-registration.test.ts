import assert from 'node:assert/strict';
import test from 'node:test';
import { Player } from '../players/player.types';
import { PlayerService } from '../players/player.service';
import { RegistrationCommandParser, RegistrationCommandParseError } from './registration-command.parser';
import { RegistrationService } from './registration.service';
import { TrainingParticipantsService } from './training-participants.service';
import { TrainingService } from './training.service';
import { Training } from './training.types';
import { backfillParticipantOwnership } from '../../app/repositories.context';
import { TrainingMessageRenderer } from './training-message.renderer';

const parser = new RegistrationCommandParser();

test('registration parser accepts human spacing, names, self aliases, and unicode dashes', () => {
    const selfAdds = ['+1', '+ 1', '+2', '+ 2', '+3', '+4'];
    const namedAdds = ['+1 Евгений', '+ 1 Евгений', '+2 Евгений'];
    const selfRemoves = ['-', '-1', '- 1', '-2', '- 2', '-3', '-4', '-я', '- я', '-1 я', '- 1 я', '- мене'];
    const namedRemoves = ['-Евгений', '- Евгений', '-1 Евгений', '- 1 Евгений', '-2 Евгений', '- 2 Евгений'];
    for (const value of selfAdds) assert.equal(parser.parse(value)?.targetType, 'self', value);
    for (const value of namedAdds) assert.equal(parser.parse(value)?.targetText, 'Евгений', value);
    for (const value of selfRemoves) assert.equal(parser.parse(value)?.targetType, 'self', value);
    for (const value of namedRemoves) assert.equal(parser.parse(value)?.targetText, 'Евгений', value);
    for (const value of ['−1', '–1', '—1']) assert.equal(parser.parse(value)?.operation, 'remove', value);
    assert.deepEqual(parser.parse('+ 2 Арсений, Александр')?.targetNames, ['Арсений', 'Александр']);
    assert.deepEqual(parser.parse('- 2 Арсений, Александр')?.targetNames, ['Арсений', 'Александр']);
});

test('registration parser rejects invalid counts and explicit-name count mismatches', () => {
    for (const value of ['+0', '+5', '-0', '-5', '+', '+abc']) {
        assert.throws(() => parser.parse(value), RegistrationCommandParseError, value);
    }
    assert.throws(() => parser.parse('+3 Арсений, Александр'), /Вказано 3 місця, але знайдено 2 імені/);
    // A word after minus is intentionally valid: it is a named cancellation.
    assert.equal(parser.parse('-abc')?.targetType, 'named');
});

test('numeric, date and natural-language suffixes are training hints rather than player names', () => {
    const selfHints = [
        '+1 на 12', '+1 12', '+1 18:00', '+1 на 18:00', '+1 на 18:30', '+1 18.30',
        '+1 18:00-20:00', '+1 18:00–20:00', '+1 12.08', '+1 на 12.08', '+1 12/08',
        '+1 12.08.2026', '+1 сьогодні', '+1 завтра', '+1 на завтра', '+1 завтра на 18:00',
        '-1 на 12', '-1 18:00',
    ];
    for (const text of selfHints) {
        const command = parser.parse(text)!;
        assert.equal(command.targetType, 'self', text);
        assert.deepEqual(command.targetNames, [], text);
        assert.ok(command.trainingHint, text);
    }
    assert.equal(parser.parse('+1 на 12')?.trainingHint?.time, '12:00');
    assert.equal(parser.parse('+1 12.08')?.trainingHint?.date, '12.08');
    assert.equal(parser.parse('+1 завтра на 18:00')?.trainingHint?.naturalDate, 'tomorrow');
    assert.equal(parser.parse('+1 завтра на 18:00')?.trainingHint?.time, '18:00');
});

test('names and combined name plus training hints remain distinct', () => {
    for (const name of ['Женя', 'Єва', 'Евгений', 'Олександр', 'Марія', 'Arseniy', 'Олександр Іваненко']) {
        assert.deepEqual(parser.parse(`+1 ${name}`)?.targetNames, [name]);
    }
    const combined = parser.parse('+1 Евгений на 18:00')!;
    assert.deepEqual(combined.targetNames, ['Евгений']);
    assert.equal(combined.trainingHint?.time, '18:00');
    const multiple = parser.parse('+2 Арсений, Александр на 18:00')!;
    assert.deepEqual(multiple.targetNames, ['Арсений', 'Александр']);
    assert.equal(multiple.trainingHint?.time, '18:00');
    const removal = parser.parse('-1 Евгений на 18:00')!;
    assert.deepEqual(removal.targetNames, ['Евгений']);
    assert.equal(removal.trainingHint?.time, '18:00');
});

function createHarness(placesLimit = 12) {
    let value: Training = {
        id: 'training', clubId: 'club', chatId: -100, messageId: 10, title: 'Training',
        date: '2099-08-11', startTime: '19:00', endTime: '21:00', placesLimit, minPlayers: 1,
        status: 'open', participants: [], waitlist: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const trainingService = {
        resolveTargetTraining: async () => value,
        findByMessageId: async (chatId: number, messageId: number) => value.chatId === chatId && value.messageId === messageId ? value : undefined,
        listRelevantOpenByChatId: async (chatId: number) => value.chatId === chatId && value.status === 'open' ? [value] : [],
        isRelevantOpen: (training: Training, chatId: number) => training.chatId === chatId && training.status === 'open',
        getRequired: async () => value,
        save: async (next: Training) => { value = structuredClone(next); return structuredClone(value); },
    } as unknown as TrainingService;
    const players: Player[] = [];
    const playerApi = {
        findByTelegramId: async (id: number) => players.find((player) => player.telegramUserId === id),
        findOrCreateByTelegramUser: async (user: { id: number; first_name?: string }) => {
            let player = players.find((item) => item.telegramUserId === user.id);
            if (!player) {
                player = makePlayer(user.first_name ?? String(user.id), user.id, 'telegram');
                players.push(player);
            }
            return player;
        },
        resolveByStrongName: async (name: string) => {
            const matches = players.filter((player) => [player.displayName, ...player.aliases].some((value) => normalize(value) === normalize(name)));
            if (matches.length > 1) throw new Error('AMBIGUOUS_PLAYER_NAME');
            return matches[0];
        },
        resolveOrCreateTelegramGuest: async (name: string) => {
            let player = players.find((item) => normalize(item.displayName) === normalize(name));
            if (!player) {
                player = makePlayer(name, undefined, 'telegram_guest');
                players.push(player);
            }
            return player;
        },
    } as unknown as PlayerService;
    const participants = new TrainingParticipantsService(trainingService);
    const registration = new RegistrationService(playerApi, trainingService, participants);
    const execute = async (text: string, id: number, first_name: string) => registration.executeCommand({
        telegramUser: { id, first_name }, chatId: -100, command: parser.parse(text)!,
    });
    return { execute, get: () => value, players, participants };
}

function normalize(value: string): string { return value.trim().toLocaleLowerCase('uk'); }
function makePlayer(displayName: string, telegramUserId?: number, source: Player['source'] = 'telegram_guest'): Player {
    const now = new Date().toISOString();
    return { id: `p-${displayName}-${telegramUserId ?? 'guest'}`, displayName, telegramUserId, aliases: [], isConfirmed: false, isActive: true, source, createdAt: now, updatedAt: now };
}

test('self increments up to four and cancellation decrements/removes only self', async () => {
    const h = createHarness();
    await h.execute('+1', 1, 'Марія');
    await h.execute('+2', 1, 'Марія');
    assert.equal(h.get().participants[0].places, 3);
    await assert.rejects(() => h.execute('+2', 1, 'Марія'), /MAX_REGISTRATION_PLACES/);
    await h.execute('-2', 1, 'Марія');
    assert.equal(h.get().participants[0].places, 1);
    await h.execute('-4', 1, 'Марія');
    assert.equal(h.get().participants.length, 0);
});

test('self registration quantities obey arithmetic semantics for every command history', async () => {
    const cases: Array<{ commands: string[]; expected: number }> = [
        { commands: ['+1', '+1', '+1', '-2'], expected: 1 },
        { commands: ['+2', '-2'], expected: 0 },
        { commands: ['+4', '-3'], expected: 1 },
        { commands: ['+1', '-4'], expected: 0 },
        { commands: ['+1', '+1', '-1'], expected: 1 },
        { commands: ['+3', '-1', '-1'], expected: 1 },
        { commands: ['+1', '+1', '+1', '-1', '-1', '-1'], expected: 0 },
    ];
    for (const { commands, expected } of cases) {
        const h = createHarness(20);
        for (const command of commands) await h.execute(command, 77, 'Папаня');
        const places = [...h.get().participants, ...h.get().waitlist]
            .filter((entry) => entry.registeredByTelegramUserId === 77 && entry.source === 'telegram_self')
            .reduce((sum, entry) => sum + entry.places, 0);
        assert.equal(places, expected, commands.join(' '));
    }
});

test('equivalent aggregate and repeated-add histories both leave one place after -2', async () => {
    const totals: number[] = [];
    for (const commands of [['+3', '-2'], ['+1', '+1', '+1', '-2']]) {
        const h = createHarness(20);
        for (const command of commands) await h.execute(command, 77, 'Папаня');
        totals.push([...h.get().participants, ...h.get().waitlist].reduce((sum, entry) => sum + entry.places, 0));
    }
    assert.deepEqual(totals, [1, 1]);
});

test('plain -N consumes split self entries across waitlist then main list and preserves named guests', async () => {
    const h = createHarness(3);
    await h.execute('+1', 77, 'Папаня');
    const selfPlayer = h.players[0];
    const value = h.get();
    value.participants = [
        { id: 'self-active-old', playerId: selfPlayer.id, displayName: 'Папаня', telegramUserId: 77, registeredByTelegramUserId: 77, places: 2, source: 'telegram_self', status: 'active', createdAt: '2026-08-15T10:00:00.000Z', updatedAt: '' },
        { id: 'named-guest', playerId: 'guest', displayName: 'Іван', registeredByTelegramUserId: 77, places: 1, source: 'telegram_guest', status: 'active', createdAt: '2026-08-15T11:00:00.000Z', updatedAt: '' },
    ];
    value.waitlist = [
        { id: 'self-wait-new', playerId: selfPlayer.id, displayName: 'Папаня', telegramUserId: 77, registeredByTelegramUserId: 77, places: 1, source: 'telegram_self', status: 'waiting', createdAt: '2026-08-15T12:00:00.000Z', updatedAt: '' },
    ];

    await h.execute('-2', 77, 'Папаня');

    assert.deepEqual(h.get().waitlist, []);
    assert.equal(h.get().participants.find((entry) => entry.id === 'self-active-old')?.places, 1);
    assert.equal(h.get().participants.find((entry) => entry.id === 'named-guest')?.places, 1);
});

test('named registrations are separate, sender-owned, and protected from another sender', async () => {
    const h = createHarness();
    await h.execute('+3 Евгений', 1, 'Олександр');
    const guest = h.get().participants[0];
    assert.equal(guest.displayName, 'Евгений');
    assert.equal(guest.places, 3);
    assert.equal(guest.registeredByTelegramUserId, 1);
    assert.equal(guest.source, 'telegram_guest');
    await assert.rejects(() => h.execute('-1 Евгений', 2, 'Марія'), /NO_REMOVABLE_REGISTRATION/);
    await h.execute('-2 Евгений', 1, 'Олександр');
    assert.equal(h.get().participants[0].places, 1);
    await h.execute('-Евгений', 1, 'Олександр');
    assert.equal(h.get().participants.length, 0);
});

test('multiple names create separate entries and can be cancelled as one sender-owned command', async () => {
    const h = createHarness();
    await h.execute('+2 Арсений, Александр', 1, 'Олександр');
    assert.deepEqual(h.get().participants.map((entry) => [entry.displayName, entry.places]), [['Арсений', 1], ['Александр', 1]]);
    await h.execute('-2 Арсений, Александр', 1, 'Олександр');
    assert.equal(h.get().participants.length, 0);
});

test('capacity uses places, keeps entries atomic, and promotion skips entries that do not fit', async () => {
    const h = createHarness(4);
    await h.execute('+2', 1, 'Main');
    await h.execute('+3 Anna', 2, 'Sender A');
    await h.execute('+1 Boris', 3, 'Sender B');
    await h.execute('+2 Clara', 4, 'Sender C');
    assert.deepEqual(h.get().participants.map((entry) => entry.displayName), ['Main', 'Boris']);
    assert.deepEqual(h.get().waitlist.map((entry) => entry.displayName), ['Anna', 'Clara']);
    await h.execute('-1', 1, 'Main');
    assert.deepEqual(h.get().participants.map((entry) => entry.displayName), ['Main', 'Boris', 'Clara']);
    assert.equal(h.participants.countActivePlaces(h.get()), 4);
    await h.execute('-1 Anna', 2, 'Sender A');
    assert.equal(h.get().waitlist[0].places, 2);
});

test('real command regression sequence is parsed and ownership remains correct', async () => {
    const h = createHarness(20);
    const commands: Array<[string, number, string, boolean?]> = [
        ['+1', 1, 'Олександр'], ['+1', 2, 'Марія'], ['+1 Евгений', 1, 'Олександр'],
        ['-1', 2, 'Марія'], ['-1 я', 1, 'Олександр'], ['-1', 1, 'Олександр', true],
        ['-1 Евгений', 1, 'Олександр'], ['+2 Арсений, Александр', 1, 'Олександр'],
        ['-2', 1, 'Олександр', true], ['+3', 2, 'Марія'], ['-2 Арсений, Александр', 1, 'Олександр'],
        ['-2', 2, 'Марія'], ['- 1', 2, 'Марія'], ['-Евгений', 1, 'Олександр', true],
    ];
    for (const [text, id, name, expectedDomainError] of commands) {
        assert.ok(parser.parse(text), `parser rejected ${text}`);
        if (expectedDomainError) await assert.rejects(() => h.execute(text, id, name));
        else await h.execute(text, id, name);
    }
    assert.equal(h.get().participants.length, 0);
    assert.equal(h.get().waitlist.length, 0);
});

test('legacy ownership migration identifies self entries but never guesses guest ownership', () => {
    const h = createHarness();
    const training = h.get();
    training.participants = [
        { id: 'self', playerId: 'telegram-player', displayName: 'Self', places: 1, source: 'telegram', status: 'active', createdAt: '', updatedAt: '' },
        { id: 'guest', playerId: 'guest-player', displayName: 'Guest', places: 1, source: 'telegram', status: 'active', createdAt: '', updatedAt: '' },
        { id: 'admin', playerId: 'admin-player', displayName: 'Admin', places: 1, source: 'admin', status: 'active', createdAt: '', updatedAt: '' },
    ];
    const players = [makePlayer('Self', 42), { ...makePlayer('Guest'), id: 'guest-player' }];
    players[0].id = 'telegram-player';
    assert.equal(backfillParticipantOwnership([training], players), 2);
    assert.equal(training.participants[0].registeredByTelegramUserId, 42);
    assert.equal(training.participants[0].source, 'telegram_self');
    assert.equal(training.participants[1].registeredByTelegramUserId, undefined);
    assert.equal(training.participants[1].source, 'telegram_guest');
    assert.equal(training.participants[2].source, 'admin');
    assert.equal(backfillParticipantOwnership([training], players), 0);
});

test('renderer expands reserved places and keeps explicit people on separate rows', async () => {
    const h = createHarness();
    await h.execute('+3 Евгений', 1, 'Олександр');
    await h.execute('+2 Арсений, Александр', 1, 'Олександр');
    const rendered = new TrainingMessageRenderer().render({ training: h.get(), players: h.players });
    assert.match(rendered, /1\. Евгений\n2\. \+1\n3\. \+1\n4\. Арсений\n5\. Александр/);
    assert.doesNotMatch(rendered, /Евгений \(3/);
});
