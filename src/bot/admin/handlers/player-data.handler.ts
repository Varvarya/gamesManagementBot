import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { BackupService } from '../../../storage/backup.service';
import { PlayerImportPlan, PlayerImportService } from '../../../domain/players/player-import.service';
import { PlayerExportService } from '../../../domain/players/player-export.service';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { AdminFlowState } from '../flows/admin-flow.types';
import { createPlayerExportKeyboard, createPlayerImportKeyboard, createPlayerImportPreviewKeyboard, createPlayersKeyboard } from '../keyboards/player.keyboard';
import { logger } from '../../../utils/logger';
import { PlayerDuplicateService } from '../../../domain/players/player-duplicate.service';

export class PlayerDataHandler {
    readonly messageStates: readonly AdminFlowState[] = ['waiting_player_import_file', 'player_import_preview', 'player_import_conflicts', 'player_import_ready'];
    private readonly imports: PlayerImportService;
    constructor(private readonly services: ServicesContext, backups: BackupService) {
        this.imports = new PlayerImportService(services.repositories.clubId, services.repositories.players, () => backups.create());
    }

    canHandle(callback: string): boolean { return callback === AdminCallbacks.PlayerImport || callback.startsWith('pi:') || callback === AdminCallbacks.PlayerExport || callback.startsWith('pe:') || callback === AdminCallbacks.PlayerDuplicates; }

    async handle(ctx: Context, callback: string): Promise<void> {
        const adminId = ctx.from?.id;
        if (!adminId) return;
        if (callback === AdminCallbacks.PlayerImport) {
            this.services.adminFlow.start(adminId, 'waiting_player_import_file');
            await this.services.adminUi.show(ctx, '📥 Імпорт гравців\n\nНадішліть CSV-файл зі списком гравців.', createPlayerImportKeyboard()); return;
        }
        if (callback === AdminCallbacks.PlayerImportTemplate) { await this.sendDocument(ctx, new PlayerExportService('', '', this.services.repositories.players).template(), 'players-template.csv', '📄 Шаблон CSV'); return; }
        if (callback === AdminCallbacks.PlayerImportFormat) {
            await this.services.adminUi.show(ctx, 'Обовʼязкова колонка: displayName.\n\nДодаткові: telegramUserId, telegramUsername, aliases, confirmed, active.\nAliases розділяються символом |. Підтримуються CSV з комою або крапкою з комою.', createPlayerImportKeyboard()); return;
        }
        if (callback === AdminCallbacks.PlayerImportCancel) { this.services.adminFlow.reset(adminId); await this.showPlayerRoot(ctx, 'Імпорт скасовано. Дані не змінено.'); return; }
        if (callback === AdminCallbacks.PlayerImportSkipConflicts) {
            const plan = this.pendingPlan(adminId);
            if (plan.errors.length) { await this.services.adminUi.replaceWithError(ctx, 'У файлі є помилки. Виправте їх перед імпортом.', createPlayerImportPreviewKeyboard(true)); return; }
            plan.conflicts = []; plan.conflictCount = 0;
            this.services.adminFlow.transition(adminId, 'player_import_ready', { pendingImport: plan });
            await this.services.adminUi.show(ctx, this.renderPreview(plan, 'Конфліктні рядки буде пропущено.'), createPlayerImportPreviewKeyboard(false)); return;
        }
        if (callback === AdminCallbacks.PlayerImportConfirm) {
            const plan = this.pendingPlan(adminId);
            try {
                const result = await this.imports.commit(plan);
                this.services.adminFlow.reset(adminId);
                await this.showPlayerRoot(ctx, `Імпорт завершено: нових ${result.created}, оновлено ${result.updated}, без змін ${result.unchanged}.`);
            } catch (error) {
                logger.error('player_import_failed', { clubId: this.services.repositories.clubId, reason: error instanceof Error ? error.message : String(error) });
                await this.services.adminUi.replaceWithError(ctx, this.importError(error), createPlayerImportPreviewKeyboard(false));
            }
            return;
        }
        if (callback === AdminCallbacks.PlayerExport) { await this.services.adminUi.show(ctx, '📤 Експорт гравців\n\nОберіть формат.', createPlayerExportKeyboard()); return; }
        if (callback === AdminCallbacks.PlayerExportCsv || callback === AdminCallbacks.PlayerExportJson) {
            const settings = await this.services.repositories.settings.get();
            const exporter = new PlayerExportService(settings.clubId, settings.title, this.services.repositories.players);
            const date = new Date().toISOString().slice(0, 10);
            if (callback === AdminCallbacks.PlayerExportCsv) await this.sendDocument(ctx, await exporter.csv(), `players-${date}.csv`, '📊 CSV експорт гравців');
            else await this.sendDocument(ctx, `${JSON.stringify(await exporter.json(), null, 2)}\n`, `players-${date}.json`, '📦 JSON backup гравців');
            return;
        }
        if (callback === AdminCallbacks.PlayerDuplicates) await this.showDuplicates(ctx);
    }

    canHandleMessage(adminId: number): boolean { return this.messageStates.includes(this.services.adminFlow.getState(adminId)); }
    async handleMessage(ctx: Context): Promise<boolean> {
        if (!ctx.from || !ctx.message || !this.canHandleMessage(ctx.from.id)) return false;
        if (!('document' in ctx.message)) { await this.services.adminUi.notice(ctx, 'Надішліть CSV-файл або натисніть «Назад».'); return true; }
        try {
            const csv = await this.readCsv(ctx, ctx.message.document);
            const plan = await this.imports.preview(csv);
            this.services.adminFlow.transition(ctx.from.id, plan.conflicts.length || plan.errors.length ? 'player_import_conflicts' : 'player_import_ready', { pendingImport: plan });
            await this.services.adminUi.show(ctx, this.renderPreview(plan), createPlayerImportPreviewKeyboard(Boolean(plan.conflicts.length || plan.errors.length)));
        } catch (error) {
            logger.error('player_import_failed', { clubId: this.services.repositories.clubId, reason: error instanceof Error ? error.message : String(error) });
            await this.services.adminUi.replaceWithError(ctx, this.importError(error), createPlayerImportKeyboard());
        }
        return true;
    }

    private pendingPlan(adminId: number): PlayerImportPlan {
        const plan = this.services.adminFlow.getData(adminId).pendingImport as PlayerImportPlan | undefined;
        if (!plan) throw new Error('IMPORT_PLAN_STALE');
        return structuredClone(plan);
    }
    private renderPreview(plan: PlayerImportPlan, note?: string): string {
        const details = [...plan.errors.slice(0, 5).map((error) => `Рядок ${error.rowNumber}: ${error.message}`), ...plan.conflicts.slice(0, 5).map((conflict) => conflict.message)];
        return ['📥 Імпорт гравців', '', `У файлі: ${plan.rowCount}`, `🆕 Нових: ${plan.newCount}`, `🔄 Оновлень: ${plan.updateCount}`, `⚠️ Потребують перевірки: ${plan.conflictCount}`, `✓ Без змін: ${plan.unchangedCount}`, `❌ Помилок: ${plan.errorCount}`, note ? `\n${note}` : '', ...(details.length ? ['', ...details] : [])].join('\n');
    }
    private async readCsv(ctx: Context, document: { file_id: string; file_size?: number; file_name?: string }): Promise<string> {
        if ((document.file_size ?? 0) > 2_000_000) throw new Error('Файл завеликий. Максимальний розмір — 2 МБ.');
        if (document.file_name && !document.file_name.toLocaleLowerCase().endsWith('.csv')) throw new Error('Файл не схожий на CSV.');
        const response = await fetch(await ctx.telegram.getFileLink(document.file_id));
        if (!response.ok) throw new Error('Не вдалося завантажити файл. Спробуйте ще раз.');
        return response.text();
    }
    private async sendDocument(ctx: Context, content: string, filename: string, caption: string): Promise<void> {
        const message = await ctx.replyWithDocument({ source: Buffer.from(content, 'utf8'), filename }, { caption });
        if (ctx.chat?.type === 'private' && ctx.from) this.services.adminUi.trackBotMessage(ctx.from.id, ctx.chat.id, message.message_id);
    }
    private async showDuplicates(ctx: Context): Promise<void> {
        const players = await this.services.repositories.players.list();
        const candidates = new PlayerDuplicateService().find(players);
        const byId = new Map(players.map((player) => [player.id, player]));
        await this.services.adminUi.show(ctx, ['🧹 Дублікати', '', candidates.length ? candidates.slice(0, 20).map((candidate) => `${candidate.confidence === 'blocking' ? '🔴' : candidate.confidence === 'exact' ? '⚠️' : '💡'} ${candidate.playerIds.map((id) => byId.get(id)?.displayName ?? id).join(' ↔ ')}`).join('\n') : 'Можливих дублікатів не знайдено.'].join('\n'), createPlayersKeyboard(players.filter((player) => !player.isConfirmed && player.isActive).length));
    }
    private async showPlayerRoot(ctx: Context, message: string): Promise<void> { const players = await this.services.repositories.players.list(); await this.services.adminUi.show(ctx, `✅ ${message}`, createPlayersKeyboard(players.filter((player) => !player.isConfirmed && player.isActive).length)); }
    private importError(error: unknown): string {
        const message = error instanceof Error ? error.message : '';
        if (message === 'IMPORT_PLAN_BLOCKED') return 'У файлі є невирішені конфлікти або помилки.';
        if (message === 'IMPORT_PLAN_STALE') return 'База гравців змінилася після перегляду. Завантажте CSV ще раз.';
        return message || 'Не вдалося обробити CSV.';
    }
}
