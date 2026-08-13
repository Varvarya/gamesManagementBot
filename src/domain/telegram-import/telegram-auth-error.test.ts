import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TelegramClient } from 'teleproto';
import { classifyTelegramAuthError, isRetryableTelegramAuthFailure, normalizeTelegramCode, normalizeTelegramPhone, readTelegramMtprotoConfig, TelegramAuthError, telegramAuthUserMessage } from './telegram-auth-error';
import { TelegramUserConnectionManager } from './telegram-user-connection.manager';

const validConfig = { apiId: 12345, apiHash: 'hash', encryptionKey: 'encryption-key', apiIdPresent: true, apiHashPresent: true, encryptionKeyPresent: true, valid: true };
const rpc = (message: string, code = 400) => Object.assign(new Error(message), { name: 'RPCError', code, errorMessage: message });

test('MTProto env validation uses only canonical names', () => {
    assert.equal(readTelegramMtprotoConfig({}).valid, false);
    assert.equal(readTelegramMtprotoConfig({ TELEGRAM_API_ID: '123', TELEGRAM_SESSION_ENCRYPTION_KEY: 'key' }).valid, false);
    assert.equal(readTelegramMtprotoConfig({ TELEGRAM_API_ID: 'bad', TELEGRAM_API_HASH: 'hash', TELEGRAM_SESSION_ENCRYPTION_KEY: 'key' }).valid, false);
    assert.equal(readTelegramMtprotoConfig({ TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'hash', TELEGRAM_SESSION_ENCRYPTION_KEY: 'key' }).valid, true);
    assert.equal(readTelegramMtprotoConfig({ TELEGRAM_USER_API_ID: '123', TELEGRAM_USER_API_HASH: 'hash' } as NodeJS.ProcessEnv).valid, false);
});

test('phone/code normalization and RPC classification are deterministic', () => {
    assert.equal(normalizeTelegramPhone('380 67-123-45-67'), '+380671234567');
    assert.equal(normalizeTelegramCode('1 2 3 4 5'), '12345');
    assert.throws(() => normalizeTelegramPhone('hello'), (error: unknown) => error instanceof TelegramAuthError && error.reason === 'PHONE_NUMBER_INVALID');
    for (const [message, reason] of [['PHONE_NUMBER_INVALID', 'PHONE_NUMBER_INVALID'], ['PHONE_NUMBER_BANNED', 'PHONE_NUMBER_BANNED'], ['PHONE_CODE_INVALID', 'PHONE_CODE_INVALID'], ['PHONE_CODE_EXPIRED', 'PHONE_CODE_EXPIRED'], ['SESSION_PASSWORD_NEEDED', 'SESSION_PASSWORD_NEEDED'], ['PASSWORD_HASH_INVALID', 'PASSWORD_HASH_INVALID'], ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_UNREGISTERED'], ['FLOOD_WAIT_60', 'FLOOD_WAIT']] as const) assert.equal(classifyTelegramAuthError(rpc(message), 'code_submitted').reason, reason);
    assert.equal(classifyTelegramAuthError(new Error('connect ETIMEDOUT')).reason, 'NETWORK_ERROR');
    assert.equal(classifyTelegramAuthError(new Error('boom')).reason, 'UNKNOWN_AUTH_ERROR');
});

test('invalid code retries on the same live client and success completes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-auth-code-')); let created = 0;
    const fake = { async start(options: { phoneCode(): Promise<string>; onError(error: Error): Promise<boolean> }) { let code = await options.phoneCode(); if (code === '11111') { assert.equal(await options.onError(rpc('PHONE_CODE_INVALID')), false); code = await options.phoneCode(); } assert.equal(code, '22222'); }, disconnect: async () => undefined } as unknown as TelegramClient;
    const manager = new TelegramUserConnectionManager(directory, validConfig, { clientFactory: () => { created++; return fake; } });
    assert.equal(await manager.beginAuthentication('club-a', 10, '+380671234567'), 'code');
    assert.equal(await manager.submitCode(10, '11111'), 'code');
    assert.equal(await manager.submitCode(10, '22222'), 'completed');
    assert.equal(created, 1);
});

test('2FA invalid password retries on the same live client', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-auth-password-')); let created = 0;
    const fake = { async start(options: { phoneCode(): Promise<string>; password(): Promise<string>; onError(error: Error): Promise<boolean> }) { assert.equal(await options.phoneCode(), '12345'); let password = await options.password(); if (password === 'wrong') { assert.equal(await options.onError(rpc('PASSWORD_HASH_INVALID')), false); password = await options.password(); } assert.equal(password, 'correct'); }, disconnect: async () => undefined } as unknown as TelegramClient;
    const manager = new TelegramUserConnectionManager(directory, validConfig, { clientFactory: () => { created++; return fake; } });
    assert.equal(await manager.beginAuthentication('club-a', 10, '+380671234567'), 'code');
    assert.equal(await manager.submitCode(10, '12345'), 'password');
    assert.equal(await manager.submitPassword(10, 'wrong'), 'password');
    assert.equal(await manager.submitPassword(10, 'correct'), 'completed');
    assert.equal(created, 1);
});

test('terminal errors preserve original RPC details and temporary state expires', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-auth-expiry-')); let now = 1_000; const failure = rpc('PHONE_CODE_EXPIRED');
    const fake = { async start(options: { phoneCode(): Promise<string>; onError(error: Error): Promise<boolean> }) { await options.phoneCode(); await options.onError(failure); throw failure; }, disconnect: async () => undefined } as unknown as TelegramClient;
    const manager = new TelegramUserConnectionManager(directory, validConfig, { clientFactory: () => fake, now: () => now, authTtlMs: 100 });
    assert.equal(await manager.beginAuthentication('club-a', 10, '+380671234567'), 'code');
    assert.equal(await manager.submitCode(10, '12345'), 'failed');
    const classified = manager.getAuthenticationFailure(10);
    assert.equal(classified.reason, 'PHONE_CODE_EXPIRED'); assert.equal(classified.original, failure); assert.match(telegramAuthUserMessage(classified), /неактуальний/);
    const waiting = { async start(options: { phoneCode(): Promise<string> }) { await options.phoneCode(); }, disconnect: async () => undefined } as unknown as TelegramClient;
    const expiring = new TelegramUserConnectionManager(directory, validConfig, { clientFactory: () => waiting, now: () => now, authTtlMs: 100 });
    assert.equal(await expiring.beginAuthentication('club-a', 11, '+380671234567'), 'code'); now += 101;
    assert.throws(() => expiring.getAuthenticationFailure(11), (error: unknown) => error instanceof TelegramAuthError && error.reason === 'AUTH_FLOW_EXPIRED');
});

test('encryption/persistence failures and retry policy remain distinct', () => {
    assert.equal(new TelegramAuthError('SESSION_ENCRYPTION_FAILED', 'session_encrypt', new Error('cipher')).reason, 'SESSION_ENCRYPTION_FAILED');
    assert.equal(new TelegramAuthError('SESSION_PERSIST_FAILED', 'session_persist', new Error('disk')).reason, 'SESSION_PERSIST_FAILED');
    assert.equal(isRetryableTelegramAuthFailure('PHONE_CODE_INVALID'), true); assert.equal(isRetryableTelegramAuthFailure('PASSWORD_HASH_INVALID'), true); assert.equal(isRetryableTelegramAuthFailure('TELEGRAM_API_CREDENTIALS_INVALID'), false);
});
