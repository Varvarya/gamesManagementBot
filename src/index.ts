import 'dotenv/config';
import { ApplicationContext } from './app/application.context';
import { loadEnv } from './config/env';
import { configureLogger, logger } from './utils/logger';

async function main(): Promise<void> {
    const env = loadEnv();
    configureLogger(env.logLevel);

    const application = await ApplicationContext.create({
        botToken: env.botToken,
        dataDir: env.dataDir,
        superAdminIds: env.superAdminIds,
        defaultTimezone: env.defaultTimezone,
    });

    process.once('SIGINT', () => {
        logger.info('process.signal_received', { signal: 'SIGINT' });
        void application.stop('SIGINT').catch((error) => logger.error('application.shutdown_failed', { signal: 'SIGINT', error }));
    });

    process.once('SIGTERM', () => {
        logger.info('process.signal_received', { signal: 'SIGTERM' });
        void application.stop('SIGTERM').catch((error) => logger.error('application.shutdown_failed', { signal: 'SIGTERM', error }));
    });

    await application.start();
}

void main().catch((error: unknown) => {
    logger.error('application.start_failed', { error });
    process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { error });
    process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { error: reason });
});
