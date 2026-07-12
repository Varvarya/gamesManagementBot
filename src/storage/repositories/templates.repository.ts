import { TrainingTemplate } from '../../domain/templates/template.types';
import { BaseJsonRepository } from './baseJsonRepository';

export class TemplatesRepository extends BaseJsonRepository<TrainingTemplate> {
    async listEnabled(): Promise<TrainingTemplate[]> {
        const templates = await this.list();

        return templates.filter((template) => template.enabled);
    }

    async listByClubId(clubId: string): Promise<TrainingTemplate[]> {
        const templates = await this.list();

        return templates.filter((template) => template.clubId === clubId);
    }

    async findMatching(input: {
        clubId: string;
        chatId: number;
        dayOfWeek: number;
        startTime: string;
    }): Promise<TrainingTemplate | undefined> {
        const templates = await this.list();

        return templates.find(
            (template) =>
                template.clubId === input.clubId &&
                template.chatId === input.chatId &&
                template.dayOfWeek === input.dayOfWeek &&
                template.startTime === input.startTime,
        );
    }
}