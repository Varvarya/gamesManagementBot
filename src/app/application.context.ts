import { Telegraf } from 'telegraf';

import { AdminCallbackRouter } from '../bot/admin/admin-callback-router';
import { AdminTextRouter } from '../bot/admin/admin-text-router';

import { PlayerFlowHandler } from '../bot/admin/flows/player-flow.handler';
import { TemplateFlowHandler } from '../bot/admin/flows/template-flow.handler';
import { TrainingFlowHandler } from '../bot/admin/flows/training-flow.handler';

import { AdminMenuHandler } from '../bot/admin/handlers/admin-menu.handler';
import { AdminPlayerHandler } from '../bot/admin/handlers/admin-player.handler';
import { AdminSettingsHandler } from '../bot/admin/handlers/admin-settings.handler';
import { AdminTemplateHandler } from '../bot/admin/handlers/admin-template.handler';
import { AdminTrainingHandler } from '../bot/admin/handlers/admin-training.handler';
import { AdminChatHandler } from '../bot/admin/handlers/admin-chat.handler';

import { GroupRegistrationHandler } from '../bot/handlers/group-registration.handler';
import { SuperAdminConfigHandler } from '../bot/handlers/super-admin-config.handler';

import { SuperAdminConfigService } from '../domain/config/super-admin-config.service';
import { TemplateSchedulerService } from '../domain/templates/template-scheduler.service';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';

import { JsonStorage } from '../storage/jsonStorage';

import { RepositoriesContext } from './repositories.context';
import { ServicesContext } from './services.context';

import { TrainingCancellationScheduler } from '../scheduler/training-cancellation.scheduler';
import {SettingsFlowHandler} from "../bot/admin/flows/settings-flow.handler";
import { BackupService } from '../storage/backup.service';
import { waitForPendingWrites } from '../storage/atomicWrite';
import { logger } from '../utils/logger';
import { resolveClubStorage } from '../storage/clubStorageResolver';


type ApplicationContextOptions = {
    botToken: string;
    dataDir: string;
    clubId?: string;
    clubName?: string;
    superAdminIds: number[];
    defaultTimezone: string;
};

export class ApplicationContext {
    readonly storage: JsonStorage;
    readonly repositories: RepositoriesContext;
    readonly services: ServicesContext;
    readonly bot: Telegraf;

    readonly trainingPublisher: TrainingPublisherService;
    readonly templateScheduler: TemplateSchedulerService;
    readonly superAdminConfig: SuperAdminConfigService;
    readonly backups: BackupService;

    readonly trainingCancellationScheduler: TrainingCancellationScheduler;

    private readonly superAdminIds: number[];
    private isShuttingDown = false;
    private handlersRegistered = false;

    private constructor(
        options: ApplicationContextOptions,
        storage: JsonStorage,
        repositories: RepositoriesContext,
    ) {
        this.storage = storage;
        this.repositories = repositories;

        this.services = new ServicesContext(
            this.repositories,
        );

        this.bot = new Telegraf(
            options.botToken,
        );

        this.trainingPublisher =
            new TrainingPublisherService(
                this.bot.telegram,
                this.repositories,
                this.services.trainings,
                this.services.trainingMessageRenderer,
            );

        this.services.trainings.setOnChanged(
            async (training) => {
                await this.trainingPublisher.refreshMessage(training.id);
                await this.services.adminUi.refreshTrainingCards(training.id);
            },
        );

        this.trainingCancellationScheduler =
            new TrainingCancellationScheduler(
                this.repositories,
                this.services.trainings,
                this.trainingPublisher,
            );

        this.trainingPublisher.setOnPublished(
            async (training) => {
                await this.trainingCancellationScheduler.schedule(
                    training,
                );
            },
        );

        this.templateScheduler =
            new TemplateSchedulerService(
                this.services.templates,
                this.services.scheduler,
                this.trainingPublisher,
                this.services.chats,
                this.repositories.settings,
            );

        this.backups = new BackupService(this.storage, 5);
        this.superAdminConfig =
            new SuperAdminConfigService(
                this.repositories,
                this.templateScheduler,
                this.backups,
            );

        this.superAdminIds =
            options.superAdminIds;
    }

    static async create(
        options: ApplicationContextOptions,
    ): Promise<ApplicationContext> {
        const resolved = await resolveClubStorage({ dataDir: options.dataDir, clubId: options.clubId, clubName: options.clubName });
        const storage = new JsonStorage({ dataDir: options.dataDir, storageSlug: resolved.storageSlug });
        await storage.ensureReady();
        const repositories = new RepositoriesContext(storage, options.defaultTimezone, resolved);
        await repositories.loadAll();
        const application = new ApplicationContext(options, storage, repositories);

        return application;
    }

    async start(): Promise<void> {
        logger.info('application.scheduler_restore_started');

        await this.restoreScheduler();
        await this.trainingCancellationScheduler.restore();

        logger.info('application.scheduler_restored');
        this.registerHandlers();
        logger.info('application.bot_launch_started');

        await this.bot.launch({
            dropPendingUpdates: true,
        });

        logger.info('application.bot_started');
    }

    async stop(signal?: string): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.services.scheduler.cancelAll();
        this.trainingCancellationScheduler.cancelAll();

        this.bot.stop(signal);
        await waitForPendingWrites();

        logger.info('application.stopped', { signal });
    }

    private registerHandlers(): void {
        if (this.handlersRegistered) return;
        this.handlersRegistered = true;
        this.bot.use(async (_ctx, next) => {
            if (this.isShuttingDown) return;
            await next();
        });
        const groupRegistrationHandler =
            new GroupRegistrationHandler(
                this.services,
                this.trainingPublisher,
            );

        const templateFlowHandler =
            new TemplateFlowHandler(
                this.services,
                this.templateScheduler,
            );

        const playerFlowHandler =
            new PlayerFlowHandler(
                this.services,
                this.trainingPublisher,
            );

        const trainingFlowHandler =
            new TrainingFlowHandler(
                this.services,
                this.trainingPublisher,
            );

        const adminMenuHandler =
            new AdminMenuHandler(
                this.services,
            );

        const adminTrainingHandler =
            new AdminTrainingHandler(
                this.services,
                this.trainingPublisher,
            );

        const adminPlayerHandler =
            new AdminPlayerHandler(
                this.services,
            );

        const adminTemplateHandler =
            new AdminTemplateHandler(
                this.services,
                this.templateScheduler,
            );

        const adminSettingsHandler =
            new AdminSettingsHandler(
                this.services,
                this.trainingCancellationScheduler,
                this.backups,
                this.templateScheduler,
            );

        const adminChatHandler =
            new AdminChatHandler(
                this.services,
            );

        const settingsFlowHandler =
            new SettingsFlowHandler(
                this.services,
                adminSettingsHandler,
            );

        const superAdminConfigHandler =
            new SuperAdminConfigHandler(
                this.services,
                this.superAdminConfig,
                this.superAdminIds,
            );

        const adminCallbackRouter =
            new AdminCallbackRouter(
                this.services,

                templateFlowHandler,
                playerFlowHandler,
                trainingFlowHandler,

                adminMenuHandler,
                adminTrainingHandler,
                adminPlayerHandler,
                adminTemplateHandler,
                adminChatHandler,
                adminSettingsHandler,
            );

        const adminTextRouter =
            new AdminTextRouter(
                this.services,
                [adminChatHandler, settingsFlowHandler, superAdminConfigHandler],
                [templateFlowHandler, playerFlowHandler, trainingFlowHandler, settingsFlowHandler],
                this.superAdminIds,
            );

        this.bot.start(
            async (ctx) => {
                await adminMenuHandler.showMain(
                    ctx,
                );
            },
        );

        this.bot.command(
            'admin',
            async (ctx) => {
                await adminMenuHandler.showMain(ctx);
            },
        );

        this.bot.command(
            'import',
            async (ctx) => {
                await superAdminConfigHandler.startImport(
                    ctx,
                );
            },
        );

        this.bot.command(
            'export',
            async (ctx) => {
                await superAdminConfigHandler.exportConfig(
                    ctx,
                );
            },
        );
        this.bot.command('backup', async (ctx) => { await superAdminConfigHandler.createBackup(ctx); });

        this.bot.on(
            'callback_query',
            async (ctx) => {
                if (
                    await superAdminConfigHandler.handleCallback(
                        ctx,
                    )
                ) {
                    return;
                }

                await adminCallbackRouter.handle(
                    ctx,
                );
            },
        );

        this.bot.on(
            'message',
            async (ctx) => {
                if (
                    ctx.chat.type === 'private'
                ) {
                    await adminTextRouter.handle(
                        ctx,
                    );

                    return;
                }

                await groupRegistrationHandler.handle(
                    ctx,
                );
            },
        );

        this.bot.catch(
            async (error, ctx) => {
                logger.error('telegram.update_failed', { updateId: ctx.update.update_id, error });
                try {
                    if (ctx.chat?.type === 'private') await this.services.adminUi.notice(ctx, 'Сталася помилка. Дані не втрачено; спробуйте ще раз або поверніться до меню.');
                    else await ctx.reply('Сталася помилка. Дані не втрачено; спробуйте ще раз.');
                } catch (replyError) {
                    logger.error('telegram.error_reply_failed', { updateId: ctx.update.update_id, error: replyError });
                }
            },
        );
    }

    private async restoreScheduler(): Promise<void> {
        const templates =
            await this.repositories.templates.listEnabled();

        const restoredJobCount =
            await this.templateScheduler.restore(
            templates,
        );

        logger.info('scheduler.restore_completed', { restoredJobCount });
    }
}
