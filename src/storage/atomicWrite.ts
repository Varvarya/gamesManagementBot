import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteJson<T>(
    filePath: string,
    data: T,
): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${filePath}.tmp`;

    const json = JSON.stringify(data, null, 2);

    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, filePath);
}