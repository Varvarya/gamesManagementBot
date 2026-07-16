import { PlayerService } from '../domain/players/player.service';
import { RegistrationService } from '../domain/trainings/registration.service';
import { TrainingMessageRenderer } from '../domain/trainings/training-message.renderer';
import { TrainingParticipantsService } from '../domain/trainings/training-participants.service';
import { TrainingService } from '../domain/trainings/training.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { RepositoriesContext } from './repositories.context';
import { TemplateService } from '../domain/templates/template.service';
import { AdminFlowService } from '../bot/admin/flows/admin-flow.service';
import { AdminUi } from '../bot/admin/ui/admin-ui';

export class ServicesContext {
    readonly repositories: RepositoriesContext;

    readonly players: PlayerService;
    readonly trainings: TrainingService;
    readonly trainingParticipants: TrainingParticipantsService;
    readonly registration: RegistrationService;
    readonly trainingMessageRenderer: TrainingMessageRenderer;
    readonly scheduler: SchedulerService;
    readonly templates: TemplateService;
    readonly adminFlow: AdminFlowService;

    readonly adminUi: AdminUi;

    constructor(repositories: RepositoriesContext) {
        this.repositories = repositories;

        this.players = new PlayerService(repositories);
        this.trainings = new TrainingService(repositories);

        this.trainingParticipants = new TrainingParticipantsService(
            this.trainings,
        );

        this.registration = new RegistrationService(
            this.players,
            this.trainings,
            this.trainingParticipants,
        );
        this.templates = new TemplateService(repositories);
        this.adminFlow = new AdminFlowService();

        this.trainingMessageRenderer = new TrainingMessageRenderer();

        this.scheduler = new SchedulerService(this.trainings);

        this.adminUi = new AdminUi();
    }
}