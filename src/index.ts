import 'dotenv/config';
import { ApplicationContext } from './app/application.context';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
    console.log('[BOOT] main started');

    const env = loadEnv();

    console.log('[BOOT] env loaded');

    const application = await ApplicationContext.create({
        botToken: env.botToken,
        dataDir: env.dataDir,
        clubId: env.clubId,
        superAdminIds: env.superAdminIds,
    });

    console.log('[BOOT] application created');

    process.once('SIGINT', () => {
        console.log('[BOOT] SIGINT received');
        application.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
        console.log('[BOOT] SIGTERM received');
        application.stop('SIGTERM');
    });

    console.log('[BOOT] starting application');

    await application.start();

    console.log('[BOOT] application.start resolved');
}

void main().catch((error: unknown) => {
    console.error('[BOOT] Failed to start application:', error);
    process.exitCode = 1;
});

process.on('beforeExit', (code) => {
    console.log('[PROCESS] beforeExit', code);
});

process.on('exit', (code) => {
    console.log('[PROCESS] exit', code);
});

process.on('uncaughtException', (error) => {
    console.error('[PROCESS] uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('[PROCESS] unhandledRejection', reason);
});