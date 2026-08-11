import { Training } from '../../domain/trainings/training.types';
import { BaseJsonRepository } from './baseJsonRepository';

export class TrainingsRepository extends BaseJsonRepository<Training> {
    async findByMessageId(
        chatId: number,
        messageId: number,
    ): Promise<Training | undefined> {
        const trainings = await this.list();

        return trainings.find(
            (training) =>
                training.chatId === chatId && training.messageId === messageId,
        );
    }

    async listByChatId(chatId: number): Promise<Training[]> {
        const trainings = await this.list();

        return trainings.filter((training) => training.chatId === chatId);
    }

    async listOpenByChatId(chatId: number): Promise<Training[]> {
        const trainings = await this.list();

        return trainings.filter(
            (training) => training.chatId === chatId && training.status === 'open',
        );
    }

    async listActive(): Promise<Training[]> {
        const trainings = await this.list();

        return trainings.filter((training) =>
            ['open', 'closed'].includes(training.status),
        );
    }

    async listArchived(input?: { month?: string; query?: string }): Promise<Training[]> {
        const trainings = await this.list();
        const query = input?.query?.trim().toLocaleLowerCase('uk');
        return trainings.filter((training) => {
            if (training.status !== 'archived' && training.status !== 'finished') return false;
            if (input?.month && !training.date.startsWith(`${input.month}-`)) return false;
            if (query && !training.title.toLocaleLowerCase('uk').includes(query) && !training.date.includes(query)) return false;
            return true;
        });
    }

    async findByTemplateAndDate(
        templateId: string,
        date: string,
    ): Promise<Training | undefined> {
        const trainings = await this.list();

        return trainings.find(
            (training) =>
                training.templateId === templateId && training.date === date,
        );
    }

    async findByTemplateSlotAndDate(input: {
        templateId: string;
        templateSlotId: string;
        date: string;
    }): Promise<Training | undefined> {
        const trainings =
            await this.list();

        return trainings.find(
            (training) =>
                training.templateId ===
                input.templateId &&
                training.templateSlotId ===
                input.templateSlotId &&
                training.date ===
                input.date &&
                training.status !==
                'cancelled',
        );
    }

    async findAnyByTemplateSlotAndDate(templateSlotId: string, date: string): Promise<Training | undefined> {
        return (await this.list()).find((training) => training.templateSlotId === templateSlotId && training.date === date);
    }
}
