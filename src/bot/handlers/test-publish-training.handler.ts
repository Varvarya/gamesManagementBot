import { Context } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { TrainingPublisherService } from '../../domain/trainings/training-publisher.service';

export class TestPublishTrainingHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly publisher: TrainingPublisherService,
    ) {}

    async handle(ctx: Context): Promise<void> {
        if (!ctx.from || ctx.chat?.type !== 'private') {
            return;
        }

        const settings = await this.services.repositories.settings.get();

        const isAdmin = settings.admins.some(
            (admin) => admin.telegramUserId === ctx.from?.id,
        );

        if (!isAdmin) {
            await ctx.reply('⛔️ У вас немає доступу до адмінки');
            return;
        }

        if (!settings.chatId) {
            await ctx.reply(
                'Спочатку вкажіть chatId групи у settings.json',
            );
            return;
        }

        const trainingDate = this.getTomorrowDate(settings.timezone);

        const training = await this.services.trainings.createDraft({
            clubId: settings.clubId,
            chatId: settings.chatId,
            title: 'Тестове тренування',
            date: trainingDate,
            startTime: '19:30',
            durationMinutes: 120,
            placesLimit: 12,
            minPlayers: 8,
        });

        const initialText =
            this.services.trainingMessageRenderer.render({
                training: {
                    ...training,
                    status: 'open',
                },
                players: [],
            });

        await this.publisher.publishManual({
            clubId: settings.clubId,
            chatId: settings.chatId,
            title: 'Тестове тренування',
            date: trainingDate,
            startTime: '19:30',
            durationMinutes: 120,
            placesLimit: 12,
            minPlayers: 8,
        });

        await ctx.reply('✅ Тестове тренування опубліковано');
    }

    private getTomorrowDate(timezone: string): string {
        const now = new Date();

        const localDate = new Date(
            now.toLocaleString('en-US', {
                timeZone: timezone,
            }),
        );

        localDate.setDate(localDate.getDate() + 1);

        const year = localDate.getFullYear();
        const month = String(localDate.getMonth() + 1).padStart(2, '0');
        const day = String(localDate.getDate()).padStart(2, '0');

        return `${year}-${month}-${day}`;
    }
}