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
import path from 'node:path';
import fs from 'node:fs/promises';
import { ClubRepository } from '../storage/repositories/club.repository';
import { ClubCreationRequestRepository } from '../storage/repositories/club-creation-request.repository';
import { ClubManagementHandler } from '../bot/handlers/club-management.handler';
import { CallbackAuthorizationService } from '../bot/authorization/callback-authorization.service';
import { SessionContextService } from '../bot/session/session-context.service';
import { ClubHealthService } from '../domain/clubs/club-health.service';
import { AdminNavigationService } from '../bot/navigation/admin-navigation.service';
import { ClubContextManager, ClubRuntimeContext } from './club-context-manager';
import { AdminUi } from '../bot/admin/ui/admin-ui';
import { AdminFlowService } from '../bot/admin/flows/admin-flow.service';


type ApplicationContextOptions = {
    botToken: string;
    dataDir: string;
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
    readonly bot: Telegraf;
    readonly clubs: ClubRepository;
    readonly clubCreationRequests: ClubCreationRequestRepository;
    readonly callbackAuthorization: CallbackAuthorizationService;
    readonly sessionContexts: SessionContextService;
    readonly clubHealth: ClubHealthService;
    readonly navigation: AdminNavigationService;
    readonly clubContexts: ClubContextManager;

    private readonly superAdminIds: number[];
    private isShuttingDown = false;
    private handlersRegistered = false;
    private readonly clubRuntimes = new Map<string, Promise<ClubHandlerRuntime>>();
    private readonly dataDir: string;
    private readonly defaultTimezone: string;

    private constructor(
        options: ApplicationContextOptions,
    ) {
        this.sessionContexts = new SessionContextService();
        this.bot = new Telegraf(
            options.botToken,
        );
        this.superAdminIds =
            options.superAdminIds;
        this.dataDir = options.dataDir;
        this.defaultTimezone = options.defaultTimezone;
        this.clubs = new ClubRepository(options.dataDir, options.defaultTimezone);
        this.clubCreationRequests = new ClubCreationRequestRepository(path.join(options.dataDir, '_system', 'club-creation-requests.json'));
        this.clubContexts = new ClubContextManager(options.dataDir, options.defaultTimezone, this.clubs, this.sessionContexts);
        this.clubHealth = new ClubHealthService(this.clubs, options.dataDir, Number(process.env.CLUB_INACTIVE_DAYS ?? 30), this.clubContexts);
        this.navigation = new AdminNavigationService(this.sessionContexts, new AdminUi(this.sessionContexts), new AdminFlowService());
        this.callbackAuthorization = new CallbackAuthorizationService(this.clubs, this.clubCreationRequests, this.superAdminIds, this.sessionContexts);
    }

    static async create(
        options: ApplicationContextOptions,
    ): Promise<ApplicationContext> {
        await fs.mkdir(path.join(options.dataDir, '_system'), { recursive: true });
        const application = new ApplicationContext(options);
        await application.clubs.findAll();
        await application.clubCreationRequests.load();
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
                    await ctx.reply('Сталася помилка. Дані не втрачено; спробуйте ще раз.');
                } catch (replyError) {
                    logger.error('telegram.error_reply_failed', { updateId: ctx.update.update_id, error: replyError });
                }
            },
        );
    }

    private async restoreScheduler(): Promise<void> {
        let totalRestoredJobCount = 0;
        for (const club of await this.clubs.findAll()) {
            if (club.status === 'disabled') continue;
            try {
                const runtime = await this.getClubRuntime(club.id);
                const templates = await runtime.context.repositories.templates.listEnabled();
                const restoredJobCount = await runtime.templateScheduler.restore(templates);
                totalRestoredJobCount += restoredJobCount;
                await runtime.cancellationScheduler.restore({ reconcileOverdue: false });
                const expectedJobCount = templates.reduce((count, template) => count + template.slots.filter((slot) => slot.enabled).length, 0);
                await this.clubs.recordSchedulerRestore(club.id, expectedJobCount, restoredJobCount);
                logger.info('scheduler.restore_completed', { clubId: club.id, restoredJobCount });
            } catch (error) {
                logger.error('scheduler.restore_failed', { clubId: club.id, reason: error instanceof Error ? error.message : String(error) });
            }
        }
        logger.info('scheduler.restore_all_completed', { restoredJobCount: totalRestoredJobCount });
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
