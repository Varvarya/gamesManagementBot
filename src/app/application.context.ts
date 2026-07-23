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


type ApplicationContextOptions = {
    botToken: string;
    dataDir: string;
    clubId: string;
    superAdminIds: number[];
};

export class ApplicationContext {
    readonly storage: JsonStorage;
    readonly repositories: RepositoriesContext;
    readonly services: ServicesContext;
    readonly bot: Telegraf;

    readonly trainingPublisher: TrainingPublisherService;
    readonly templateScheduler: TemplateSchedulerService;
    readonly superAdminConfig: SuperAdminConfigService;

    readonly trainingCancellationScheduler: TrainingCancellationScheduler;

    private readonly superAdminIds: number[];

    private constructor(
        options: ApplicationContextOptions,
    ) {
        this.storage = new JsonStorage({
            dataDir: options.dataDir,
            clubId: options.clubId,
        });

        this.repositories = new RepositoriesContext(
            this.storage,
        );

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
            );

        this.superAdminConfig =
            new SuperAdminConfigService(
                this.repositories,
                this.templateScheduler,
            );

        this.superAdminIds =
            options.superAdminIds;
    }

    static async create(
        options: ApplicationContextOptions,
    ): Promise<ApplicationContext> {
        const application =
            new ApplicationContext(options);

        await application.repositories.loadAll();

        application.registerHandlers();

        return application;
    }

    async start(): Promise<void> {
        console.log('[APP] restoring scheduler');

        await this.restoreScheduler();
        await this.trainingCancellationScheduler.restore();

        console.log('[APP] scheduler restored');
        console.log('[APP] launching Telegram bot');

        await this.bot.launch({
            dropPendingUpdates: true,
        });

        console.log('[APP] Telegram bot started');
    }

    stop(signal?: string): void {
        this.services.scheduler.cancelAll();
        this.trainingCancellationScheduler.cancelAll();

        this.bot.stop(signal);

        console.log(
            signal
                ? `Telegram bot stopped: ${signal}`
                : 'Telegram bot stopped',
        );
    }

    private registerHandlers(): void {
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
            );

        const settingsFlowHandler =
            new SettingsFlowHandler(
                this.services,
                adminSettingsHandler,
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
                adminSettingsHandler,
            );

        const adminTextRouter =
            new AdminTextRouter(
                this.services,
                templateFlowHandler,
                playerFlowHandler,
                trainingFlowHandler,
                settingsFlowHandler,
            );

        const superAdminConfigHandler =
            new SuperAdminConfigHandler(
                this.services,
                this.superAdminConfig,
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
            'text',
            async (ctx) => {
                if (
                    ctx.chat.type === 'private'
                ) {
                    if (
                        await superAdminConfigHandler.handleText(
                            ctx,
                        )
                    ) {
                        return;
                    }

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
            (error, ctx) => {
                console.error(
                    `Telegram update failed: ${ctx.update.update_id}`,
                    error,
                );
            },
        );
    }

    private async restoreScheduler(): Promise<void> {
        const templates =
            await this.repositories.templates.listEnabled();

        this.templateScheduler.restore(
            templates,
        );

        console.log(
            'Template scheduler restored',
        );
    }
}