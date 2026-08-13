import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type EncryptedTelegramSession = { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };

export class TelegramSessionCipher {
    private readonly key: Buffer;
    constructor(secret: string) {
        if (!secret.trim()) throw new Error('TELEGRAM_SESSION_ENCRYPTION_KEY is required.');
        this.key = createHash('sha256').update(secret, 'utf8').digest();
    }
    encrypt(value: string): EncryptedTelegramSession {
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    }
    decrypt(value: EncryptedTelegramSession): string {
        if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') throw new Error('Unsupported encrypted Telegram session format');
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    }
}
