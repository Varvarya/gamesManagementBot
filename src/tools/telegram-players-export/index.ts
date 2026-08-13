import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { createClubSlug } from '../../storage/clubSlug';
import { TelegramPlayerCandidateBuilder } from './telegram-player-candidate';
import { TelegramPlayerCsvWriter } from './telegram-player-csv';
import { TelegramContactsLoader, TelegramGroupDialog, TelegramParticipantLoader } from './telegram-mtproto-loader';

const SESSION_PATH = path.resolve('.telegram-session');

async function main(): Promise<void> {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) throw new CliError('TELEGRAM_API_ID and TELEGRAM_API_HASH are required.');
    const environmentSession = process.env.TELEGRAM_SESSION?.trim();
    const storedSession = environmentSession || await readSession();
    const client = new TelegramClient(new StringSession(storedSession), apiId, apiHash, { connectionRetries: 5 });
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        await client.start({
            phoneNumber: () => rl.question('Номер телефону: '),
            phoneCode: () => askSecret('Код входу: '),
            password: () => askSecret('Пароль 2FA: '),
            onError: (error) => printAuthHint(error),
        });
        if (!environmentSession) await fs.writeFile(SESSION_PATH, client.session.save(), { encoding: 'utf8', mode: 0o600 });
        const participantLoader = new TelegramParticipantLoader(client);
        const groups = await participantLoader.listGroups();
        const selected = await selectGroup(groups, rl, process.argv.slice(2));
        if (!selected) { console.log('Вихід без експорту.'); return; }
        console.log(`\nОтримую учасників «${selected.title}»…`);
        const [participantResult, contacts] = await Promise.all([
            participantLoader.load(selected), new TelegramContactsLoader(client).load(),
        ]);
        const built = new TelegramPlayerCandidateBuilder().build(participantResult.participants, contacts);
        const slug = createClubSlug(selected.title);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputDirectory = path.resolve('exports');
        const csvPath = path.join(outputDirectory, `players-import-${slug}-${stamp}.csv`);
        const rawPath = path.join(outputDirectory, `players-export-raw-${slug}-${stamp}.json`);
        await fs.mkdir(outputDirectory, { recursive: true });
        await fs.writeFile(csvPath, new TelegramPlayerCsvWriter().serialize(built.candidates), 'utf8');
        await fs.writeFile(rawPath, JSON.stringify({
            exportedAt: new Date().toISOString(),
            chat: { id: selected.id, title: selected.title },
            partial: participantResult.partial,
            reportedParticipantTotal: participantResult.reportedTotal,
            participants: participantResult.participants,
            contacts,
            candidates: built.candidates,
        }, null, 2), 'utf8');
        const matchedContacts = built.candidates.filter((item) => item.isContact).length;
        const contactNames = built.candidates.filter((item) => Boolean(item.contactDisplayName)).length;
        console.log(['', 'Готово.', '', 'Чат:', selected.title, '',
            `Учасників отримано: ${built.receivedCount}`,
            `Контактів знайдено: ${matchedContacts}`,
            `Ім’я взято з контактів: ${contactNames}`,
            `Ім’я взято з Telegram: ${built.candidates.length - contactNames}`,
            `Потребують перевірки: ${built.candidates.filter((item) => item.needsReview).length}`,
            `Ботів пропущено: ${built.botCount}`,
            `Видалених акаунтів пропущено: ${built.deletedCount}`,
            ...(built.duplicateCount ? [`Дублікатів ID пропущено: ${built.duplicateCount}`] : []),
            '', `CSV:\n${relative(csvPath)}`, `Raw JSON:\n${relative(rawPath)}`,
            ...(participantResult.partial ? ['', '⚠️ Telegram не надав повний список учасників цього чату.'] : []),
        ].join('\n'));
    } finally {
        rl.close();
        await client.disconnect().catch(() => undefined);
    }
}

async function selectGroup(groups: TelegramGroupDialog[], rl: ReturnType<typeof createInterface>, args: string[]): Promise<TelegramGroupDialog | undefined> {
    const id = option(args, '--chat-id');
    const title = option(args, '--chat-title');
    if (id) {
        const match = groups.find((group) => group.id === id);
        if (!match) throw new CliError(`Чат з ID ${id} не знайдено серед доступних груп.`);
        return match;
    }
    if (title) {
        const matches = groups.filter((group) => normalize(group.title) === normalize(title));
        if (matches.length !== 1) throw new CliError(matches.length ? 'Знайдено кілька чатів із такою назвою. Використайте --chat-id.' : `Чат «${title}» не знайдено.`);
        return matches[0];
    }
    if (!groups.length) throw new CliError('Не знайдено доступних груп або супергруп.');
    console.log('\nОберіть чат:\n');
    groups.forEach((group, index) => console.log(`${index + 1}. ${group.title}`));
    console.log('0. Вийти');
    while (true) {
        const selected = Number((await rl.question('\nНомер: ')).trim());
        if (selected === 0) return undefined;
        if (Number.isInteger(selected) && groups[selected - 1]) return groups[selected - 1];
        console.log('Введіть номер зі списку.');
    }
}

async function readSession(): Promise<string> { try { return (await fs.readFile(SESSION_PATH, 'utf8')).trim(); } catch (error) { return hasCode(error, 'ENOENT') ? '' : Promise.reject(error); } }
function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1); }
function normalize(value: string): string { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk'); }
function relative(value: string): string { return `./${path.relative(process.cwd(), value)}`; }
function hasCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code); }

async function askSecret(prompt: string): Promise<string> {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new CliError('Інтерактивний пароль 2FA потребує TTY. Запустіть команду в терміналі.');
    stdout.write(prompt); stdin.setRawMode(true); stdin.resume();
    return new Promise((resolve) => {
        let value = '';
        const onData = (data: Buffer) => {
            for (const byte of data) {
                if (byte === 3) { cleanup(); process.kill(process.pid, 'SIGINT'); return; }
                if (byte === 13 || byte === 10) { cleanup(); stdout.write('\n'); resolve(value); return; }
                if (byte === 127 || byte === 8) value = value.slice(0, -1);
                else value += Buffer.from([byte]).toString();
            }
        };
        const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); };
        stdin.on('data', onData);
    });
}

function printAuthHint(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/FLOOD_WAIT/i.test(message)) console.error('Telegram тимчасово обмежив запити. Зачекайте вказаний час і повторіть.');
    else if (/PHONE_CODE/i.test(message)) console.error('Код входу недійсний або прострочений. Спробуйте ще раз.');
    else if (/SESSION_PASSWORD/i.test(message)) console.error('Пароль 2FA неправильний. Спробуйте ще раз.');
    else console.error('Не вдалося авторизуватися в Telegram. Перевірте мережу та облікові дані.');
}

class CliError extends Error {}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE|PARTICIPANTS/i.test(message)) console.error('Не вдалося отримати список учасників: чат обмежений або акаунт не має доступу.');
    else if (/FLOOD_WAIT/i.test(message)) console.error('Telegram тимчасово обмежив запити. Зачекайте та повторіть запуск.');
    else if (error instanceof CliError) console.error(message);
    else console.error(`Не вдалося виконати експорт: ${message}`);
    process.exitCode = 1;
});
