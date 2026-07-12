import { ActionLog } from '../../domain/logs/log.types';
import { BaseJsonRepository } from './baseJsonRepository';

export class LogsRepository extends BaseJsonRepository<ActionLog> {
    async listByTrainingId(trainingId: string): Promise<ActionLog[]> {
        const logs = await this.list();

        return logs.filter((log) => log.trainingId === trainingId);
    }

    async listByPlayerId(playerId: string): Promise<ActionLog[]> {
        const logs = await this.list();

        return logs.filter((log) => log.playerId === playerId);
    }

    async listIgnored(): Promise<ActionLog[]> {
        const logs = await this.list();

        return logs.filter((log) => log.type === 'ignored_action');
    }
}