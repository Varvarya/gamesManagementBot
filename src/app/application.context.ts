import { Context, Telegraf } from 'telegraf';

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
import { AdminCallbacks } from '../bot/admin/callbacks/admin-callbacks';

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
import path from 'node:path';
import { ClubRepository } from '../storage/repositories/club.repository';
import { ClubCreationRequestRepository } from '../storage/repositories/club-creation-request.repository';
import { ClubManagementHandler } from '../bot/handlers/club-management.handler';
import { CallbackAuthorizationService } from '../bot/authorization/callback-authorization.service';
import { SessionContextService } from '../bot/session/session-context.service';
import { ClubHealthService } from '../domain/clubs/club-health.service';
import { AdminNavigationService } from '../bot/navigation/admin-navigation.service';
import { ClubContextManager, ClubRuntimeContext } from './club-context-manager';


type ApplicationContextOptions = {
    botToken: string;
    dataDir: string;
    clubId?: string;
    clubName?: string;
    superAdminIds: number[];
    defaultTimezone: string;
};

type ClubHandlerRuntime = {
    context: ClubRuntimeContext;
    publisher: TrainingPublisherService;
    templateScheduler: TemplateSchedulerService;
    cancellationScheduler: TrainingCancellationScheduler;
    menu: AdminMenuHandler;
    callbackRouter: AdminCallbackRouter;
    textRouter: AdminTextRouter;
    groupRegistration: GroupRegistrationHandler;
    superAdminConfig: SuperAdminConfigHandler;
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
    readonly clubs: ClubRepository;
    readonly clubCreationRequests: ClubCreationRequestRepository;
    readonly callbackAuthorization: CallbackAuthorizationService;
    readonly sessionContexts: SessionContextService;
    readonly clubHealth: ClubHealthService;
    readonly navigation: AdminNavigationService;
    readonly clubContexts: ClubContextManager;

    readonly trainingCancellationScheduler: TrainingCancellationScheduler;

    private readonly superAdminIds: number[];
    private isShuttingDown = false;
    private handlersRegistered = false;
    private readonly clubRuntimes = new Map<string, Promise<ClubHandlerRuntime>>();
    private readonly dataDir: string;
    private readonly defaultTimezone: string;

    private constructor(
        options: ApplicationContextOptions,
        storage: JsonStorage,
        repositories: RepositoriesContext,
    ) {
        this.storage = storage;
        this.repositories = repositories;
        this.sessionContexts = new SessionContextService();

        this.services = new ServicesContext(
            this.repositories,
            this.sessionContexts,
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
                await this.clubs.touchActivity(this.repositories.clubId);
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
                await this.clubs.recordSuccessfulPublication(this.repositories.clubId);
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
        this.dataDir = options.dataDir;
        this.defaultTimezone = options.defaultTimezone;
        this.clubs = new ClubRepository(options.dataDir, options.defaultTimezone);
        this.clubCreationRequests = new ClubCreationRequestRepository(path.join(options.dataDir, '_system', 'club-creation-requests.json'));
        this.clubContexts = new ClubContextManager(options.dataDir, options.defaultTimezone, this.clubs, this.sessionContexts);
        this.clubContexts.registerClubContext({ clubId: repositories.clubId, storageSlug: path.basename(storage.getDirectoryPath()), directoryPath: storage.getDirectoryPath(), repositories, services: this.services });
        this.clubHealth = new ClubHealthService(this.clubs, options.dataDir, Number(process.env.CLUB_INACTIVE_DAYS ?? 30), this.clubContexts);
        this.navigation = new AdminNavigationService(this.sessionContexts, this.services.adminUi, this.services.adminFlow);
        this.callbackAuthorization = new CallbackAuthorizationService(this.clubs, this.clubCreationRequests, this.superAdminIds, this.sessionContexts);
        this.services.chats.setOnChanged(async () => { await this.clubs.touchActivity(this.repositories.clubId); });
        this.services.templates.setOnChanged(async () => { await this.clubs.touchActivity(this.repositories.clubId); });
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
        await application.clubCreationRequests.load();
        await application.clubs.registerExisting(await repositories.settings.get());

        return application;
    }

    async start(): Promise<void> {
        this.registerHandlers();
        logger.info('application.bot_launch_started');

        // Connectivity is validated before any scheduler reconciliation. In
        // particular, an overdue minimum check cannot cancel a training while
        // the application is only half started.
        await this.bot.telegram.getMe();
        await this.bot.telegram.setMyCommands([
            { command: 'start', description: 'Почати' },
            { command: 'help', description: 'Допомога' },
        ]);

        await this.bot.launch({
            dropPendingUpdates: true,
        });

        logger.info('application.scheduler_restore_started');
        await this.restoreScheduler();
        logger.info('application.scheduler_restored');
        logger.info('application.bot_started');
    }

    async stop(signal?: string): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.services.scheduler.cancelAll();
        this.trainingCancellationScheduler.cancelAll();
        for (const runtimePromise of this.clubRuntimes.values()) {
            const runtime = await runtimePromise.catch(() => undefined);
            runtime?.context.services.scheduler.cancelAll();
            runtime?.cancellationScheduler.cancelAll();
        }

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
                this.superAdminIds,
                this.sessionContexts,
            );

        const clubManagementHandler = new ClubManagementHandler(
            this.bot,
            this.clubs,
            this.clubCreationRequests,
            this.superAdminIds,
            this.callbackAuthorization,
            this.sessionContexts,
            this.clubHealth,
            this.navigation,
            async (ctx) => {
                const selectedClubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
                if (!selectedClubId) throw new Error('No active club selected');
                try { await (await this.getClubRuntime(selectedClubId)).menu.showMain(ctx); }
                catch (error) {
                    logger.error('club.context_activation_failed', { clubId: selectedClubId, reason: error instanceof Error ? error.message : String(error) });
                    await ctx.reply('⚠️ Не вдалося завантажити дані обраного клубу. Дані іншого клубу не показано.');
                }
            },
            (clubId) => this.invalidateClubRuntime(clubId),
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
                this.callbackAuthorization,
                this.repositories.clubId,
                this.sessionContexts,
                this.navigation,

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
                this.callbackAuthorization,
                this.repositories.clubId,
                this.sessionContexts,
            );

        this.bot.start(
            async (ctx) => {
                if (await clubManagementHandler.handleStart(ctx)) return;
                const clubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
                if (clubId) await (await this.getClubRuntime(clubId)).menu.showMain(ctx);
            },
        );

        this.bot.command(
            'admin',
            async (ctx) => {
                if (await clubManagementHandler.handleStart(ctx)) return;
                const clubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
                if (clubId) await (await this.getClubRuntime(clubId)).menu.showMain(ctx);
            },
        );

        this.bot.help(async (ctx) => {
            if (await clubManagementHandler.handleStart(ctx)) return;
            const clubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
            if (clubId) await (await this.getClubRuntime(clubId)).menu.handle(ctx, AdminCallbacks.Help);
        });

        this.bot.command(
            'import',
            async (ctx) => {
                const runtime = await this.getSelectedClubRuntime(ctx);
                if (runtime) await runtime.superAdminConfig.startImport(ctx);
            },
        );

        this.bot.command(
            'export',
            async (ctx) => {
                const runtime = await this.getSelectedClubRuntime(ctx);
                if (runtime) await runtime.superAdminConfig.exportConfig(ctx);
            },
        );
        this.bot.command('backup', async (ctx) => { const runtime = await this.getSelectedClubRuntime(ctx); if (runtime) await runtime.superAdminConfig.createBackup(ctx); });

        this.bot.on(
            'callback_query',
            async (ctx) => {
                if (await clubManagementHandler.handleCallback(ctx)) return;
                const configRuntime = await this.getSelectedClubRuntime(ctx, false);
                if (configRuntime && await configRuntime.superAdminConfig.handleCallback(ctx)) return;

                const clubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
                if (!clubId) { await ctx.answerCbQuery('⚠️ Це меню вже неактивне.'); return; }
                await (await this.getClubRuntime(clubId)).callbackRouter.handle(ctx);
            },
        );

        this.bot.on(
            'message',
            async (ctx) => {
                if (
                    ctx.chat.type === 'private'
                ) {
                    if (await clubManagementHandler.handleMessage(ctx)) return;
                    const clubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
                    if (clubId) await (await this.getClubRuntime(clubId)).textRouter.handle(ctx);

                    return;
                }

                const runtime = await this.findRuntimeForChat(ctx.chat.id);
                if (runtime) await runtime.groupRegistration.handle(ctx);
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
        for (const club of await this.clubs.findAll()) {
            if (club.status === 'disabled') continue;
            try {
                const runtime = await this.getClubRuntime(club.id);
                const templates = await runtime.context.repositories.templates.listEnabled();
                const restoredJobCount = await runtime.templateScheduler.restore(templates);
                await runtime.cancellationScheduler.restore({ reconcileOverdue: false });
                const expectedJobCount = templates.reduce((count, template) => count + template.slots.filter((slot) => slot.enabled).length, 0);
                await this.clubs.recordSchedulerRestore(club.id, expectedJobCount, restoredJobCount);
                logger.info('scheduler.restore_completed', { clubId: club.id, restoredJobCount });
            } catch (error) {
                logger.error('scheduler.restore_failed', { clubId: club.id, reason: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    private async getClubRuntime(clubId: string): Promise<ClubHandlerRuntime> {
        const existing = this.clubRuntimes.get(clubId);
        if (existing) return existing;
        const loading = this.clubContexts.getClubContext(clubId).then((context) => this.createClubRuntime(context));
        this.clubRuntimes.set(clubId, loading);
        try { return await loading; }
        catch (error) {
            if (this.clubRuntimes.get(clubId) === loading) this.clubRuntimes.delete(clubId);
            throw error;
        }
    }

    private invalidateClubRuntime(clubId: string): void {
        void this.clubRuntimes.get(clubId)?.then((runtime) => {
            runtime.context.services.scheduler.cancelAll();
            runtime.cancellationScheduler.cancelAll();
        }).catch(() => undefined);
        this.clubRuntimes.delete(clubId);
        this.clubContexts.invalidateClubContext(clubId);
    }

    private createClubRuntime(context: ClubRuntimeContext): ClubHandlerRuntime {
        const { repositories, services } = context;
        const publisher = new TrainingPublisherService(this.bot.telegram, repositories, services.trainings, services.trainingMessageRenderer);
        const cancellationScheduler = new TrainingCancellationScheduler(repositories, services.trainings, publisher);
        const templateScheduler = new TemplateSchedulerService(services.templates, services.scheduler, publisher, services.chats, repositories.settings);
        const storage = new JsonStorage({ dataDir: this.dataDir, storageSlug: context.storageSlug });
        const backups = new BackupService(storage, 5);
        const navigation = new AdminNavigationService(this.sessionContexts, services.adminUi, services.adminFlow);

        services.trainings.setOnChanged(async (training) => {
            await this.clubs.touchActivity(context.clubId);
            await publisher.refreshMessage(training.id);
            await services.adminUi.refreshTrainingCards(training.id);
        });
        publisher.setOnPublished(async (training) => {
            await this.clubs.recordSuccessfulPublication(context.clubId);
            await cancellationScheduler.schedule(training);
        });
        services.chats.setOnChanged(async () => { await this.clubs.touchActivity(context.clubId); });
        services.templates.setOnChanged(async () => { await this.clubs.touchActivity(context.clubId); });

        const templateFlow = new TemplateFlowHandler(services, templateScheduler);
        const playerFlow = new PlayerFlowHandler(services, publisher);
        const trainingFlow = new TrainingFlowHandler(services, publisher);
        const menu = new AdminMenuHandler(services, this.superAdminIds, this.sessionContexts);
        const training = new AdminTrainingHandler(services, publisher);
        const player = new AdminPlayerHandler(services);
        const template = new AdminTemplateHandler(services, templateScheduler);
        const settings = new AdminSettingsHandler(services, cancellationScheduler, backups, templateScheduler);
        const chat = new AdminChatHandler(services);
        const settingsFlow = new SettingsFlowHandler(services, settings);
        const configService = new SuperAdminConfigService(repositories, templateScheduler, backups);
        const superAdminConfig = new SuperAdminConfigHandler(services, configService, [...this.superAdminIds]);
        const callbackRouter = new AdminCallbackRouter(services, this.callbackAuthorization, context.clubId, this.sessionContexts, navigation, templateFlow, playerFlow, trainingFlow, menu, training, player, template, chat, settings);
        const textRouter = new AdminTextRouter(services, [chat, settingsFlow, superAdminConfig], [templateFlow, playerFlow, trainingFlow, settingsFlow], this.superAdminIds, this.callbackAuthorization, context.clubId, this.sessionContexts);
        const groupRegistration = new GroupRegistrationHandler(services, publisher);
        return { context, publisher, templateScheduler, cancellationScheduler, menu, callbackRouter, textRouter, groupRegistration, superAdminConfig };
    }

    private async findRuntimeForChat(chatId: number): Promise<ClubHandlerRuntime | undefined> {
        for (const club of await this.clubs.findAll()) {
            if (club.status === 'disabled') continue;
            try {
                const runtime = await this.getClubRuntime(club.id);
                if (await runtime.context.repositories.chats.getById(chatId)) return runtime;
            } catch { /* A broken club must not block another club's group update. */ }
        }
        return undefined;
    }

    private async getSelectedClubRuntime(ctx: Context, notify = true): Promise<ClubHandlerRuntime | undefined> {
        const clubId = ctx.from ? this.sessionContexts.get(ctx.from.id)?.activeClubId : undefined;
        if (!clubId) {
            if (notify) await ctx.reply('Спочатку відкрийте потрібний клуб.');
            return undefined;
        }
        return this.getClubRuntime(clubId);
    }
}
