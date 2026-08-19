import { AdminFlowService } from '../bot/admin/flows/admin-flow.service';
import { AdminUi } from '../bot/admin/ui/admin-ui';
import { ChatService } from '../domain/chats/chat.service';
import { PlayerService } from '../domain/players/player.service';
import { TemplateService } from '../domain/templates/template.service';
import { RegistrationService } from '../domain/trainings/registration.service';
import { TrainingMessageRenderer } from '../domain/trainings/training-message.renderer';
import { TrainingParticipantsService } from '../domain/trainings/training-participants.service';
import { TrainingService } from '../domain/trainings/training.service';
import { TrainingPlayerCreationService } from '../domain/trainings/training-player-creation.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { RepositoriesContext } from './repositories.context';
import { SettingsService } from '../domain/settings/settings.service';
import { SessionContextService } from '../bot/session/session-context.service';
import { ClubReadinessService } from '../domain/clubs/club-readiness.service';
import { ScheduleExceptionService } from '../domain/schedule-exceptions/schedule-exception.service';
import { ScheduleOccurrenceResolver } from '../domain/schedule-exceptions/schedule-occurrence.resolver';

export class ServicesContext {
    readonly repositories: RepositoriesContext;

    readonly players: PlayerService;
    readonly trainings: TrainingService;
    readonly trainingParticipants: TrainingParticipantsService;
    readonly trainingPlayerCreation: TrainingPlayerCreationService;
    readonly registration: RegistrationService;
    readonly trainingMessageRenderer: TrainingMessageRenderer;
    readonly scheduler: SchedulerService;
    readonly templates: TemplateService;
    readonly chats: ChatService;
    readonly adminFlow: AdminFlowService;
    readonly settings: SettingsService;
    readonly readiness: ClubReadinessService;
    readonly scheduleExceptions: ScheduleExceptionService;
    readonly occurrenceResolver: ScheduleOccurrenceResolver;

    readonly adminUi: AdminUi;
    readonly sessionContexts?: SessionContextService;

    constructor(
        repositories: RepositoriesContext,
        sessionContexts?: SessionContextService,
    ) {
        this.repositories = repositories;
        this.sessionContexts = sessionContexts;

        this.players =
            new PlayerService(
                repositories,
            );

        this.trainings =
            new TrainingService(
                repositories,
            );

        this.trainingParticipants =
            new TrainingParticipantsService(
                this.trainings,
            );

        this.trainingPlayerCreation = new TrainingPlayerCreationService(
            repositories,
            this.players,
            this.trainingParticipants,
        );

        this.registration =
            new RegistrationService(
                this.players,
                this.trainings,
                this.trainingParticipants,
                async () => (await repositories.settings.get()).timezone,
            );

        this.templates =
            new TemplateService(
                repositories,
            );

        this.chats =
            new ChatService(
                repositories.chats,
                async (chatId) => (await repositories.templates.list()).filter((template) => template.chatId === chatId).length,
            );

        this.adminFlow =
            new AdminFlowService();
        this.settings = new SettingsService(repositories);
        this.readiness = new ClubReadinessService(repositories);
        this.scheduleExceptions = new ScheduleExceptionService(repositories.scheduleExceptions, repositories.clubId);
        this.occurrenceResolver = new ScheduleOccurrenceResolver();

        this.trainingMessageRenderer =
            new TrainingMessageRenderer();

        this.scheduler =
            new SchedulerService();

        this.adminUi =
            new AdminUi(sessionContexts);
    }
}
