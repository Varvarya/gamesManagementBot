import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './utils/logger';

async function healthcheck(): Promise<void> {
    const dataDir = process.env.DATA_DIR?.trim();
    if (!dataDir) throw new Error('DATA_DIR is missing');
    await fs.access(path.resolve(dataDir), fs.constants.R_OK | fs.constants.W_OK);
    logger.info('healthcheck.healthy');
}
void healthcheck().catch((error) => { logger.error('healthcheck.unhealthy', { error }); process.exitCode = 1; });
