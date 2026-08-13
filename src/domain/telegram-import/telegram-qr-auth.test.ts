import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramClient } from 'teleproto';
import { TelegramQrAuthError, TelegramQrAuthService } from './telegram-qr-auth.service';
import { TelegramUserConnection } from './telegram-user-connection.types';

const connection: TelegramUserConnection = { id: 'c', shortId: 'c1', clubId: 'club-a', telegramUserId: 10, displayName: 'Admin', sessionStorageKey: 'c.json', connectedAt: new Date().toISOString(), lastValidatedAt: new Date().toISOString(), status: 'connected' };
type QrOptions = { qrCode(value: { token: Buffer; expires: number }): Promise<void>; password?(): Promise<string>; abortSignal?: AbortSignal; onError(error: Error): Promise<boolean> | void };
function managerWith(client: TelegramClient, persist: (clubId: string, userId: number, client: TelegramClient) => Promise<TelegramUserConnection> = async () => connection) { return { createQrAuthClient: () => client, getQrApiCredentials: () => ({ apiId: 123, apiHash: 'hash' }), persistAuthenticatedClient: persist }; }

test('QR auth generates an in-memory PNG and cancel invalidates the attempt', async () => {
    const fake = { connect: async () => undefined, signInUserWithQrCode: async (_credentials: unknown, options: QrOptions) => { await options.qrCode({ token: Buffer.from('secret-token'), expires: Math.floor(Date.now() / 1000) + 30 }); await new Promise<void>((_resolve, reject) => options.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }, disconnect: async () => undefined } as unknown as TelegramClient;
    const service = new TelegramQrAuthService(managerWith(fake)); const qr = await service.startQrLogin('club-a', 10);
    assert.equal(qr.png.subarray(1, 4).toString(), 'PNG'); assert.equal(qr.png.includes(Buffer.from('secret-token')), false); assert.equal(service.get(qr.id, 'club-a', 10), 'waiting_scan');
    await service.cancel(qr.id, 'club-a', 10); assert.throws(() => service.get(qr.id, 'club-a', 10), (error: unknown) => error instanceof TelegramQrAuthError && error.reason === 'QR_TOKEN_EXPIRED');
});

test('refresh invalidates the old attempt and issues a different short token', async () => {
    const clients: TelegramClient[] = [];
    const make = () => ({ connect: async () => undefined, signInUserWithQrCode: async (_c: unknown, options: QrOptions) => { await options.qrCode({ token: Buffer.from(String(clients.length)), expires: Math.floor(Date.now() / 1000) + 30 }); await new Promise<void>((_r, reject) => options.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }, disconnect: async () => undefined } as unknown as TelegramClient);
    const manager = { createQrAuthClient: () => { const value = make(); clients.push(value); return value; }, getQrApiCredentials: () => ({ apiId: 1, apiHash: 'h' }), persistAuthenticatedClient: async () => connection };
    const service = new TelegramQrAuthService(manager); const first = await service.startQrLogin('club-a', 10); const second = await service.refreshQrLogin(first.id, 'club-a', 10);
    assert.notEqual(first.id, second.id); assert.throws(() => service.get(first.id, 'club-a', 10)); await service.cancel(second.id, 'club-a', 10);
});

test('successful QR auth persists only after authorization and completes automatically', async () => {
    let persisted = 0; let completed = 0;
    const fake = { connect: async () => undefined, signInUserWithQrCode: async (_c: unknown, options: QrOptions) => { await options.qrCode({ token: Buffer.from('ok'), expires: Math.floor(Date.now() / 1000) + 30 }); return {}; }, disconnect: async () => undefined } as unknown as TelegramClient;
    const service = new TelegramQrAuthService(managerWith(fake, async (_club, user) => { assert.equal(user, 10); persisted++; return connection; }));
    await service.startQrLogin('club-a', 10, { onCompleted: async () => { completed++; } }); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(persisted, 1); assert.equal(completed, 1);
});

test('QR 2FA password is transient and wrong password can be retried', async () => {
    const seen: string[] = []; let prompts = 0;
    const fake = { connect: async () => undefined, signInUserWithQrCode: async (_c: unknown, options: QrOptions) => { await options.qrCode({ token: Buffer.from('2fa'), expires: Math.floor(Date.now() / 1000) + 30 }); let password = await options.password!(); seen.push(password); if (password === 'wrong') { await options.onError(Object.assign(new Error('PASSWORD_HASH_INVALID'), { errorMessage: 'PASSWORD_HASH_INVALID' })); password = await options.password!(); seen.push(password); } }, disconnect: async () => undefined } as unknown as TelegramClient;
    let attemptId = ''; const service = new TelegramQrAuthService(managerWith(fake)); const qr = await service.startQrLogin('club-a', 10, { onPasswordRequired: async (id) => { attemptId = id; prompts++; } });
    await new Promise((resolve) => setTimeout(resolve, 2)); await service.submitPassword(attemptId, 'club-a', 10, 'wrong'); await new Promise((resolve) => setTimeout(resolve, 2)); await service.submitPassword(attemptId, 'club-a', 10, 'correct'); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, ['wrong', 'correct']); assert.equal(prompts, 2); assert.equal(qr.id, attemptId);
});

test('account mismatch is not persisted and restart treats callbacks as stale', async () => {
    let persisted = 0; let reason = '';
    const fake = { connect: async () => undefined, signInUserWithQrCode: async (_c: unknown, options: QrOptions) => { await options.qrCode({ token: Buffer.from('x'), expires: Math.floor(Date.now() / 1000) + 30 }); }, disconnect: async () => undefined } as unknown as TelegramClient;
    const service = new TelegramQrAuthService(managerWith(fake, async () => { persisted++; throw new Error('AUTH_ACCOUNT_MISMATCH'); })); const qr = await service.startQrLogin('club-a', 10, { onFailed: async (_id, value) => { reason = value; } }); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(persisted, 1); assert.equal(reason, 'AUTH_ACCOUNT_MISMATCH');
    const afterRestart = new TelegramQrAuthService(managerWith(fake)); assert.throws(() => afterRestart.get(qr.id, 'club-a', 10), /QR_TOKEN_EXPIRED/);
});
