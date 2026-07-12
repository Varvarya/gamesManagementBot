import 'dotenv/config';
import { ApplicationContext } from './app/application.context';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
    const env = loadEnv();

    const application =
        await ApplicationContext.create({
            botToken: env.botToken,
            dataDir: env.dataDir,
            clubId: env.clubId,
            superAdminIds: env.superAdminIds,
        });

    process.once('SIGINT', () => {
        application.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
        application.stop('SIGTERM');
    });

    await application.start();
}

void main().catch((error: unknown) => {
    console.error('Failed to start application:', error);
    process.exitCode = 1;
});