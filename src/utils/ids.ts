import crypto from 'node:crypto';

export function createId(prefix?: string): string {
    const id = crypto.randomUUID();

    return prefix ? `${prefix}_${id}` : id;
}