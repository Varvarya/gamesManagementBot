import { Player } from '../players/player.types';
import {
    ParticipantEntry,
    Training,
} from './training.types';

type RenderTrainingMessageInput = {
    training: Training;
    players: Player[];
};

export class TrainingMessageRenderer {
    render({
               training,
               players,
           }: RenderTrainingMessageInput): string {
        const registered =
            this.countPlaces(
                training.participants,
            );

        const free =
            Math.max(
                training.placesLimit -
                registered,
                0,
            );

        return [
            `🏸 ${training.title}`,
            `📅 ${this.renderDate(
                training.date,
            )}`,
            `🕒 ${training.startTime}–${training.endTime}`,
            training.location
                ? `📍 ${training.location}`
                : undefined,
            '',
            this.renderStatus(
                training,
                free,
            ),
            `✅ Записані (${registered}/${training.placesLimit})`,
            `⏳ У листі очікування: ${this.countPlaces(training.waitlist)}`,
            `🪑 Вільно: ${free}`,
            `🎯 Мінімум гравців: ${training.minPlayers}`,
            '',
            '✅ Основний список',
            this.renderEntries(
                training.participants,
                players,
            ),
            '',
            '⏳ Лист очікування',
            this.renderEntries(training.waitlist, players),
            '',
            '➕ +1…+4 або +2 Імʼя',
            '➖ -1…-4',
        ]
            .filter(
                (
                    line,
                ): line is string =>
                    line !== undefined,
            )
            .join('\n');
    }

    private renderStatus(
        training: Training,
        freePlaces: number,
    ): string {
        switch (
            training.status
            ) {
            case 'open':
                return freePlaces > 0
                    ? '🟢 Статус: запис відкрито'
                    : '🟡 Статус: основний список заповнено';

            case 'closed':
                return '🔒 Статус: запис закрито';

            case 'cancelled':
                return '❌ Скасовано';

            case 'finished':
                return '✅ Завершено';

            case 'archived':
                return '📦 Архів';

            case 'draft':
                return '⚪ Чернетка';
        }
    }

    private renderDate(
        value: string,
    ): string {
        const match =
            value.match(
                /^(\d{4})-(\d{2})-(\d{2})$/,
            );

        return match
            ? `${match[3]}.${match[2]}.${match[1]}`
            : value;
    }

    private renderEntries(
        entries: ParticipantEntry[],
        players: Player[],
    ): string {
        if (entries.length === 0) {
            return '—';
        }

        const lines: string[] = [];
        let position = 1;

        for (const entry of entries) {
            const player =
                players.find(
                    item =>
                        item.id ===
                        entry.playerId,
                );

            const displayName =
                player?.displayName ??
                entry.displayName ??
                'Гравець';

            lines.push(
                `${position}. ${displayName}`,
            );

            position += 1;

            for (
                let placeIndex = 1;
                placeIndex < entry.places;
                placeIndex += 1
            ) {
                lines.push(
                    `${position}. +1`,
                );

                position += 1;
            }
        }

        return lines.join('\n');
    }

    private countPlaces(
        entries: ParticipantEntry[],
    ): number {
        return entries.reduce(
            (
                sum,
                entry,
            ) =>
                sum +
                entry.places,
            0,
        );
    }
}
