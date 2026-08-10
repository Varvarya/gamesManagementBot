import { ClubCreationRequest } from '../../domain/clubs/club.types';
import { createId } from '../../utils/ids';
import { BaseJsonRepository } from './baseJsonRepository';
import { randomBytes } from 'node:crypto';

export type CreateClubCreationRequest = Omit<ClubCreationRequest, 'id' | 'shortId' | 'status' | 'createdAt' | 'reviewedAt'>;

export class ClubCreationRequestRepository extends BaseJsonRepository<ClubCreationRequest> {
    private migrationRunning = false;
    private migrationComplete = false;
    override async load(): Promise<void> {
        if (this.migrationComplete || this.migrationRunning) { await super.load(); return; }
        this.migrationRunning = true;
        await super.load();
        const requests = await super.list();
        const used = new Set(requests.map((request) => request.shortId).filter(Boolean));
        let changed = false;
        for (const request of requests) {
            if (request.shortId) continue;
            request.shortId = this.createShortId(used);
            used.add(request.shortId);
            changed = true;
        }
        if (changed) await this.saveAll(requests);
        this.migrationComplete = true;
        this.migrationRunning = false;
    }

    async create(input: CreateClubCreationRequest): Promise<ClubCreationRequest> {
        if ((await this.findByRequester(input.requesterTelegramId)).some((request) => request.status === 'pending')) {
            throw new Error('Користувач уже має заявку, що очікує розгляду');
        }
        const used = new Set((await this.list()).map((request) => request.shortId));
        const request: ClubCreationRequest = {
            ...input,
            id: createId('clubrequest'),
            shortId: this.createShortId(used),
            status: 'pending',
            createdAt: new Date().toISOString(),
        };
        return this.save(request);
    }

    async findPending(): Promise<ClubCreationRequest[]> {
        return (await this.list()).filter((request) => request.status === 'pending');
    }

    async findByRequester(telegramUserId: number): Promise<ClubCreationRequest[]> {
        return (await this.list()).filter((request) => request.requesterTelegramId === telegramUserId);
    }

    async findByShortId(shortId: string): Promise<ClubCreationRequest | undefined> {
        return (await this.list()).find((request) => request.shortId === shortId);
    }

    async approve(id: string, reviewedByTelegramId?: number): Promise<ClubCreationRequest> {
        return this.review(id, 'approved', reviewedByTelegramId);
    }

    async reject(id: string, reviewedByTelegramId?: number, reviewComment?: string): Promise<ClubCreationRequest> {
        return this.review(id, 'rejected', reviewedByTelegramId, reviewComment);
    }

    private async review(id: string, status: 'approved' | 'rejected', reviewedByTelegramId?: number, reviewComment?: string): Promise<ClubCreationRequest> {
        const request = await this.findById(id);
        if (!request) throw new Error('Заявку не знайдено');
        if (request.status !== 'pending') throw new Error('Заявку вже розглянуто');
        return this.save({ ...request, status, reviewedAt: new Date().toISOString(), reviewedByTelegramId, reviewComment });
    }

    private createShortId(used: ReadonlySet<string>): string {
        for (let attempt = 0; attempt < 100; attempt++) {
            const token = randomBytes(6).toString('base64url');
            if (!used.has(token)) return token;
        }
        throw new Error('Unable to allocate unique ClubCreationRequest shortId');
    }
}
