import { Telegraf } from 'telegraf';
import { GroupRegistrationHandler } from '../bot/handlers/group-registration.handler';
import { TestPublishTrainingHandler } from '../bot/handlers/test-publish-training.handler';
import { JsonStorage } from '../storage/jsonStorage';
import { RepositoriesContext } from './repositories.context';
import { ServicesContext } from './services.context';
import { TrainingPublisherService } from '../domain/trainings/training-publisher.service';
import { AdminMenuHandler } from '../bot/admin/handlers/admin-menu.handler';
import { AdminFlowHandler } from '../bot/handlers/admin-flow.handler';
import { TemplateSchedulerService } from '../domain/templates/template-scheduler.service';
import {SuperAdminConfigService} from "../domain/config/super-admin-config.service";
import {SuperAdminConfigHandler} from "../bot/handlers/super-admin-config.handler";

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
    private readonly superAdminIds: number[];

    private constructor(options: ApplicationContextOptions) {
        this.storage = new JsonStorage({
            dataDir: options.dataDir,
            clubId: options.clubId,
        });

        this.repositories = new RepositoriesContext(this.storage);
        this.services = new ServicesContext(this.repositories);
        this.bot = new Telegraf(options.botToken);
        this.trainingPublisher = new TrainingPublisherService(
            this.bot.telegram,
            this.repositories,
            this.services.trainings,
            this.services.trainingMessageRenderer,
        );
        this.templateScheduler = new TemplateSchedulerService(
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
        const application = new ApplicationContext(options);

        await application.repositories.loadAll();
        application.registerHandlers();

        return application;
    }

    async start(): Promise<void> {
        await this.restoreScheduler();

        await this.bot.launch({
            dropPendingUpdates: true,
        });

        console.log('Telegram bot started');
    }

    stop(signal?: string): void {
        this.services.scheduler.cancelAll();
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

        const testPublishTrainingHandler =
            new TestPublishTrainingHandler(
                this.services,
                this.trainingPublisher,
            );

        const adminMenuHandler =
            new AdminMenuHandler(
                this.services,
                this.templateScheduler,
                this.trainingPublisher,
            );

        const adminFlowHandler = new AdminFlowHandler(
            this.services,
            this.templateScheduler,
            this.trainingPublisher,
        );

        const superAdminConfigHandler =
            new SuperAdminConfigHandler(
                this.services,
                this.superAdminConfig,
                this.superAdminIds,
            );

        this.bot.start(async (ctx) => {
            await adminMenuHandler.showMain(ctx);
        });

        this.bot.command('import', async (ctx) => {
            await superAdminConfigHandler.startImport(ctx);
        });

        this.bot.command('export', async (ctx) => {
            await superAdminConfigHandler.exportConfig(ctx);
        });

        this.bot.on('text', async (ctx) => {
            if (ctx.chat.type === 'private') {
                if (
                    await superAdminConfigHandler.handleText(
                        ctx,
                    )
                ) {
                    return;
                }

                await adminFlowHandler.handleText(ctx);
                return;
            }

            await groupRegistrationHandler.handle(ctx);
        });
        this.bot.catch((error, ctx) => {
            console.error(
                `Telegram update failed: ${ctx.update.update_id}`,
                error,
            );
        });

        this.bot.on('callback_query', async (ctx) => {
            if (
                await superAdminConfigHandler.handleCallback(
                    ctx,
                )
            ) {
                return;
            }

            if (
                await adminFlowHandler.handleCallback(ctx)
            ) {
                return;
            }

            await adminMenuHandler.handleCallback(ctx);
        });

    }

    private async restoreScheduler(): Promise<void> {
        const templates =
            await this.repositories.templates.listEnabled();

        for (const template of templates) {
            this.templateScheduler.syncTemplate(template);
        }

        console.log(
            `Scheduler restored: ${templates.length} template(s)`,
        );
    }
}