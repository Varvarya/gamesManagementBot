import fs from 'node:fs/promises';
import path from 'node:path';
import { Club, ClubHealth } from './club.types';
import { ClubRepository } from '../../storage/repositories/club.repository';
import { ClubContextManager } from '../../app/club-context-manager';
import { logger } from '../../utils/logger';
import { ClubReadinessService } from './club-readiness.service';

export class ClubHealthService {
    constructor(private readonly clubs: ClubRepository, private readonly dataDir: string, private readonly inactiveDays = 30, private readonly contexts?: ClubContextManager) {}

    async inspectAll(): Promise<ClubHealth[]> {
        const clubs = await this.clubs.findAll();
        const slugCounts = new Map<string, number>();
        for (const club of clubs) slugCounts.set(club.slug, (slugCounts.get(club.slug) ?? 0) + 1);
        return Promise.all(clubs.map((club) => this.inspect(club, (slugCounts.get(club.slug) ?? 0) > 1)));
    }

    async inspect(club: Club, duplicateSlug = false): Promise<ClubHealth> {
        if (this.contexts) return this.inspectFromContext(club, duplicateSlug);
        const problems: string[] = [];
        const directory = path.resolve(this.dataDir, club.slug);
        if (path.dirname(directory) !== path.resolve(this.dataDir) || path.basename(directory) !== club.slug) problems.push('Slug і шлях сховища не узгоджені');
        if (duplicateSlug) problems.push('Дубльований slug');
        if (!await isDirectory(directory)) problems.push('Відсутня папка сховища');

        const settings = await readJson(path.join(directory, 'settings.json'), problems, 'Пошкоджено settings.json');
        if (settings && (!isObject(settings) || settings.clubId !== club.id)) problems.push('Club ID у registry та settings не збігається');
        if (settings && (!isObject(settings) || typeof settings.title !== 'string' || !settings.title.trim())) problems.push('У settings відсутня назва');
        if (!club.admins.length) problems.push('Немає адміністраторів');

        const chatsRaw = await readJson(path.join(directory, 'chats.json'), problems, 'Не вдалося завантажити chats.json');
        const templatesRaw = await readJson(path.join(directory, 'templates.json'), problems, 'Не вдалося завантажити templates.json');
        const trainingsRaw = await readJson(path.join(directory, 'trainings.json'), problems, 'Не вдалося завантажити trainings.json');
        await readJson(path.join(directory, 'players.json'), problems, 'Не вдалося завантажити players.json');
        const chats = asCollection(chatsRaw);
        const templates = asArray(templatesRaw);
        const trainings = asArray(trainingsRaw);
        const enabledChats = chats.filter((item) => isObject(item) && item.enabled !== false).length;
        const enabledTemplates = templates.filter((item) => isObject(item) && item.enabled !== false).length;
        const expectedSchedulerJobs = templates.reduce<number>((count, item) => count + (isObject(item) && item.enabled !== false ? enabledSlots(item).length : 0), 0);
        const activeTrainings = trainings.filter((item) => isObject(item) && ['open', 'closed', 'cancelled'].includes(String(item.status))).length;

        const critical = problems.some((problem) => /папка|Пошкоджено|завантажити|не збігається|шлях|Дубльований/i.test(problem));
        let status: Club['status'];
        if (club.disabledAt || club.status === 'disabled') status = 'disabled';
        else if (critical) status = 'broken';
        else if (!enabledChats || !enabledTemplates || !club.admins.length) status = 'setup_required';
        else if (!club.lastActivityAt || Date.now() - Date.parse(club.lastActivityAt) > this.inactiveDays * 86_400_000) status = 'inactive';
        else status = 'active';
        if (!enabledChats && !critical) problems.push('Немає доданих чатів');
        if (!enabledTemplates && !critical) problems.push('Немає активних шаблонів');

        const restored = Math.max(0, club.restoredSchedulerJobs ?? 0);
        const schedulerStatus: ClubHealth['schedulerStatus'] = expectedSchedulerJobs === 0 ? 'not_configured' : restored === expectedSchedulerJobs ? 'healthy' : restored > 0 ? 'partial' : 'failed';
        return { club, status, problems, chats: enabledChats, enabledTemplates, templateCount: templates.length, activeTrainings, expectedSchedulerJobs, restoredSchedulerJobs: restored, schedulerStatus, dataAvailable: !critical };
    }

    private async inspectFromContext(club: Club, duplicateSlug: boolean): Promise<ClubHealth> {
        const problems: string[] = duplicateSlug ? ['Дубльований slug'] : [];
        try {
            const context = await this.contexts!.getClubContext(club.id);
            const settings = await context.repositories.settings.get();
            if (settings.clubId !== club.id || settings.storageSlug !== club.slug) throw new Error('Registry та settings не узгоджені');
            const effectiveClub: Club = { ...club, name: settings.title, admins: settings.admins };
            const [chats, templates, players, trainings] = await Promise.all([
                context.repositories.chats.getAll(), context.repositories.templates.list(), context.repositories.players.list(), context.repositories.trainings.list(),
            ]);
            const readiness = await new ClubReadinessService(context.repositories).calculate();
            const enabledTemplates = templates.filter((item) => item.enabled).length;
            const expectedSchedulerJobs = templates.reduce((count, item) => count + (item.enabled ? item.slots.filter((slot) => slot.enabled).length : 0), 0);
            const activeTrainings = trainings.filter((item) => ['open', 'closed', 'cancelled'].includes(item.status)).length;
            const restored = Math.max(0, club.restoredSchedulerJobs ?? 0);
            const schedulerStatus: ClubHealth['schedulerStatus'] = expectedSchedulerJobs === 0 ? 'not_configured' : restored === expectedSchedulerJobs ? 'healthy' : restored > 0 ? 'partial' : 'failed';
            let status: Club['status'];
            if (club.disabledAt || club.status === 'disabled') status = 'disabled';
            else if (duplicateSlug) status = 'broken';
            else if (!chats.length || !enabledTemplates || !settings.admins.length) status = 'setup_required';
            else if (!club.lastActivityAt || Date.now() - Date.parse(club.lastActivityAt) > this.inactiveDays * 86_400_000) status = 'inactive';
            else status = 'active';
            loggerStats(club.id, context.repositories.clubId, chats.length, templates.length);
            return { club: effectiveClub, status, problems, chats: chats.length, enabledTemplates, templateCount: templates.length, playerCount: players.length, trainingCount: trainings.length, activeTrainings, expectedSchedulerJobs, restoredSchedulerJobs: restored, schedulerStatus, dataAvailable: true, readinessReady: readiness.ready };
        } catch (error) {
            problems.push(error instanceof Error ? error.message : 'Помилка завантаження');
            return { club, status: club.status === 'disabled' ? 'disabled' : 'broken', problems, chats: 0, enabledTemplates: 0, templateCount: 0, activeTrainings: 0, expectedSchedulerJobs: 0, restoredSchedulerJobs: 0, schedulerStatus: 'failed', dataAvailable: false };
        }
    }
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asCollection(value: unknown): unknown[] { return Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []; }
function loggerStats(clubId: string, repositoryClubId: string, chatCount: number, templateCount: number): void {
    // Kept here so all Super Admin statistics use the same structured event.
    logger.info('superadmin.club_stats_loaded', { clubId, repositoryClubId, chatCount, templateCount });
}
function enabledSlots(template: Record<string, unknown>): unknown[] { return Array.isArray(template.slots) ? template.slots.filter((slot) => isObject(slot) && slot.enabled !== false) : []; }
async function isDirectory(value: string): Promise<boolean> { try { return (await fs.stat(value)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function readJson(file: string, problems: string[], message: string): Promise<unknown> {
    try { const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8')); return isObject(raw) && 'data' in raw ? raw.data : raw; }
    catch { problems.push(message); return undefined; }
}
