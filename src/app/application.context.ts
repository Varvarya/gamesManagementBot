import { Context, Telegraf } from 'telegraf';

import { AdminCallbackRouter } from '../bot/admin/admin-callback-router';
import { AdminTextRouter } from '../bot/admin/admin-text-router';

import { PlayerFlowHandler } from '../bot/admin/flows/player-flow.handler';
import { TemplateFlowHandler } from '../bot/admin/flows/template-flow.handler';
import { TrainingFlowHandler } from '../bot/admin/flows/training-flow.handler';

import { AdminMenuHandler } from '../bot/admin/handlers/admin-menu.handler';
import { ClubSetupHandler } from '../bot/admin/handlers/club-setup.handler';
import { ScheduleExceptionReconciliationService } from '../domain/schedule-exceptions/schedule-exception-reconciliation.service';
import { ScheduleExceptionHandler } from '../bot/admin/handlers/schedule-exception.handler';
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
import { PendingRegistrationSelectionStore, REGISTRATION_SELECTION_PREFIX } from '../bot/registration/pending-registration-selection.store';
import { PlayerDataHandler } from '../bot/admin/handlers/player-data.handler';
import { ClubDiagnosticsService } from '../domain/clubs/club-diagnostics.service';
import { TelegramUserConnectionManager } from '../domain/telegram-import/telegram-user-connection.manager';
import { TelegramPlayerImportService } from '../domain/telegram-import/telegram-player-import.service';
import { TelegramPlayerImportHandler } from '../bot/admin/handlers/telegram-player-import.handler';
import { TelegramQrAuthService } from '../domain/telegram-import/telegram-qr-auth.service';


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
    readonly registrationSelections = new PendingRegistrationSelectionStore();
    readonly telegramUserConnections: TelegramUserConnectionManager;
    readonly telegramQrAuth: TelegramQrAuthService;

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
        this.telegramUserConnections = new TelegramUserConnectionManager(options.dataDir);
        this.telegramQrAuth = new TelegramQrAuthService(this.telegramUserConnections);
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
            async (clubId) => {
                const context = await this.clubContexts.getClubContext(clubId);
                const settings = await context.repositories.settings.get();
                logger.info('club.open_context_shape', { clubId, contextClubId: context.clubId, contextKeys: Object.keys(context), hasRepositories: Boolean(context.repositories), hasServices: Boolean(context.services), repositoryKeys: Object.keys(context.repositories), serviceKeys: Object.keys(context.services) });
                return { clubId: context.clubId, title: context.title, storageSlug: context.storageSlug, directoryPath: context.directoryPath, settingsPath: context.repositories.settings.getFilePath(), settingsClubId: settings.clubId };
            },
            async (ctx, clubId) => { await (await this.getClubRuntime(clubId)).menu.showMain(ctx); },
            (clubId) => this.invalidateClubRuntime(clubId),
            (clubId) => new ClubDiagnosticsService(this.clubs, this.dataDir).diagnose(clubId),
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
                const callback = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
                if (callback.startsWith(REGISTRATION_SELECTION_PREFIX)) {
                    const clubId = this.registrationSelections.clubIdFor(callback);
                    if (!clubId) {
                        await ctx.answerCbQuery('⚠️ Цей вибір уже неактуальний. Надішліть команду ще раз.', { show_alert: true });
                        return;
                    }
                    await (await this.getClubRuntime(clubId)).groupRegistration.handleSelection(ctx, callback);
                    return;
                }
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
        if (existing) {
            try {
                const [runtime, validated] = await Promise.all([existing, this.clubContexts.getClubContext(clubId)]);
                if (runtime.context.clubId !== validated.clubId || runtime.context.directoryPath !== validated.directoryPath || runtime.context.repositories.clubId !== clubId) throw new Error('Cached application runtime does not match selected club');
                return runtime;
            } catch (error) {
                logger.warn('club.runtime_cache_invalid', { clubId, reason: error instanceof Error ? error.message : String(error) });
                this.invalidateClubRuntime(clubId);
                // Continue with one fresh load. No other club runtime is ever used.
            }
        }
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
        const templateScheduler = new TemplateSchedulerService(services.templates, services.scheduler, publisher, services.chats, repositories.settings, undefined, services.scheduleExceptions, services.occurrenceResolver);
        const exceptionReconciliation = new ScheduleExceptionReconciliationService(repositories, services.trainings, services.occurrenceResolver);
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
        void Promise.all([repositories.trainings.list(), repositories.settings.get()]).then(([trainings, settings]) => {
            for (const training of trainings.filter((item) => item.status === 'draft' && item.scheduledPublicationAt)) {
                const at = training.scheduledPublicationAt!;
                services.scheduler.rescheduleOneOff({ id: `club:${training.clubId}:training:${training.id}`, date: at.slice(0, 10), time: at.slice(11, 16), timezone: settings.timezone }, async () => { await publisher.publishExistingDraft(training.id); });
            }
        }).catch((error) => logger.error('training.one_off_restore_failed', { clubId: context.clubId, error }));
        services.chats.setOnChanged(async () => { await this.clubs.touchActivity(context.clubId); });
        services.templates.setOnChanged(async () => { await this.clubs.touchActivity(context.clubId); });
        services.scheduleExceptions.setOnChanged(async (exception) => {
            if (exception) {
                const result = await exceptionReconciliation.apply(exception);
                if (result.trainingId) {
                    if (result.action === 'cancelled') cancellationScheduler.cancel(result.trainingId);
                    else await cancellationScheduler.schedule(await services.trainings.getRequired(result.trainingId), { reconcileOverdue: false });
                }
            }
            await templateScheduler.syncExceptionJobs();
            await this.clubs.touchActivity(context.clubId);
        });

        const templateFlow = new TemplateFlowHandler(services, templateScheduler);
        const playerFlow = new PlayerFlowHandler(services, publisher);
        const trainingFlow = new TrainingFlowHandler(services, publisher);
        const menu = new AdminMenuHandler(services, this.superAdminIds, this.sessionContexts);
        const training = new AdminTrainingHandler(services, publisher, cancellationScheduler);
        const player = new AdminPlayerHandler(services);
        const playerData = new PlayerDataHandler(services, backups);
        const telegramPlayerImports = new TelegramPlayerImportService(context.clubId, repositories.players, this.telegramUserConnections, () => backups.create());
        const telegramPlayerImport = new TelegramPlayerImportHandler(services, this.telegramUserConnections, this.telegramQrAuth, telegramPlayerImports, this.superAdminIds);
        const setup = new ClubSetupHandler(services);
        const exceptions = new ScheduleExceptionHandler(services, exceptionReconciliation, templateScheduler, cancellationScheduler);
        const template = new AdminTemplateHandler(services, templateScheduler);
        const settings = new AdminSettingsHandler(services, cancellationScheduler, backups, templateScheduler, this.superAdminIds);
        const chat = new AdminChatHandler(services);
        const settingsFlow = new SettingsFlowHandler(services, settings);
        const configService = new SuperAdminConfigService(repositories, templateScheduler, backups);
        const superAdminConfig = new SuperAdminConfigHandler(services, configService, [...this.superAdminIds]);
        const callbackRouter = new AdminCallbackRouter(services, this.callbackAuthorization, context.clubId, this.sessionContexts, navigation, templateFlow, playerFlow, trainingFlow, menu, training, player, template, chat, settings, playerData, telegramPlayerImport, setup, exceptions);
        const textRouter = new AdminTextRouter(services, [chat, settingsFlow, superAdminConfig, playerData, telegramPlayerImport], [templateFlow, playerFlow, trainingFlow, settingsFlow, exceptions], this.superAdminIds, this.callbackAuthorization, context.clubId, this.sessionContexts, [settings]);
        const groupRegistration = new GroupRegistrationHandler(services, publisher, this.registrationSelections);
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
