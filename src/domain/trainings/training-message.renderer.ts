import { Player } from '../players/player.types';
import { ParticipantEntry, Training } from './training.types';

type RenderTrainingMessageInput = {
    training: Training;
    players: Player[];
};

export class TrainingMessageRenderer {
    render(input: RenderTrainingMessageInput): string {
        const { training, players } = input;

        return [
            this.renderStatus(training),
            '',
            `🏸 ${training.title}`,
            '',
            `📅 ${training.date}`,
            `🕢 ${this.renderTime(training)}`,
            training.location ? `📍 ${training.location}` : undefined,
            '',
            `👥 Записано: ${this.countPlaces(training.participants)} / ${training.placesLimit}`,
            `Вільно: ${this.countFreePlaces(training)}`,
            '',
            '────────────',
            '',
            '✅ Записані',
            '',
            this.renderEntries(training.participants, players),
            '',
            '────────────',
            '',
            '🕒 Очікування',
            '',
            this.renderEntries(training.waitlist, players),
            '',
            '────────────',
            '',
            'Для запису: +1 +2 +3 +4',
            'Для виписки: -1 -2',
        ]
            .filter((line): line is string => line !== undefined)
            .join('\n');
    }

    private renderStatus(training: Training): string {
        if (training.status === 'cancelled') {
            return '❌ ТРЕНУВАННЯ СКАСОВАНО';
        }

        if (training.status === 'closed') {
            return '🔒 ЗАПИС ЗАКРИТО';
        }

        if (training.status === 'finished') {
            return '✅ ТРЕНУВАННЯ ЗАВЕРШЕНО';
        }

        if (training.status === 'open') {
            const freePlaces = this.countFreePlaces(training);

            return freePlaces > 0
                ? '🟢 ВІДКРИТО ЗАПИС'
                : '🟡 МІСЦЬ НЕМАЄ / ЛИСТ ОЧІКУВАННЯ';
        }

        return '⚪️ ЧЕРНЕТКА';
    }

    private renderTime(training: Training): string {
        return `${training.startTime}–${training.endTime}`;
    }

    private renderEntries(
        entries: ParticipantEntry[],
        players: Player[],
    ): string {
        if (entries.length === 0) {
            return '—';
        }

        return entries
            .map((entry, index) => {
                const player = players.find((item) => item.id === entry.playerId);
                const name = player?.displayName || 'Unknown player';
                const places = entry.places > 1 ? ` (+${entry.places})` : '';

                return `${index + 1}. ${name}${places}`;
            })
            .join('\n');
    }

    private countPlaces(entries: ParticipantEntry[]): number {
        return entries.reduce(
            (sum, entry) => sum + entry.places,
            0,
        );
    }

    private countFreePlaces(training: Training): number {
        return Math.max(
            training.placesLimit - this.countPlaces(training.participants),
            0,
        );
    }
}