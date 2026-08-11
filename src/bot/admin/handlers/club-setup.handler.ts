import { Context } from 'telegraf';
import { ServicesContext } from '../../../app/services.context';
import { AdminCallbacks } from '../callbacks/admin-callbacks';
import { createReadinessKeyboard, createSetupOverviewKeyboard, createSetupStepKeyboard } from '../keyboards/setup.keyboard';
import { ClubReadiness } from '../../../domain/clubs/club-readiness.service';

export class ClubSetupHandler {
    constructor(private readonly services: ServicesContext) {}
    canHandle(callback: string): boolean { return [AdminCallbacks.Setup, AdminCallbacks.SetupContinue, AdminCallbacks.SetupChat, AdminCallbacks.SetupSchedule, AdminCallbacks.SetupSkip, AdminCallbacks.Readiness].includes(callback as never); }
    async handle(ctx: Context, callback: string): Promise<void> {
        const readiness = await this.services.readiness.calculate();
        if (callback === AdminCallbacks.Readiness) { await this.showCheck(ctx, readiness); return; }
        if (callback === AdminCallbacks.SetupContinue) { await this.showNext(ctx, readiness); return; }
        await this.showOverview(ctx, readiness);
    }
    async showOverview(ctx: Context, current?: ClubReadiness): Promise<void> {
        const readiness = current ?? await this.services.readiness.calculate();
        const settings = await this.services.settings.get();
        const mark = (done: boolean) => done ? '✅' : '⬜';
        const text = readiness.ready
            ? ['✅ Клуб готовий до роботи', '', '💬 Чат підключено', '📅 Розклад налаштовано', '📤 Автопублікація увімкнена']
            : [`🏸 ${settings.title}`, '', 'Налаштуємо клуб для роботи.', '', `${mark(readiness.identityConfigured)} Клуб створено`, `${mark(readiness.ownerConfigured)} Адміністратор`, `${mark(readiness.chatConfigured)} Чат`, `${mark(readiness.scheduleConfigured)} Розклад`, `${mark(readiness.publicationConfigured)} Публікація`];
        await this.services.adminUi.show(ctx, text.join('\n'), createSetupOverviewKeyboard(readiness.ready));
    }
    private async showNext(ctx: Context, readiness: ClubReadiness): Promise<void> {
        if (readiness.ready) return this.showOverview(ctx, readiness);
        const warning = readiness.warnings[0];
        const title = warning.repair === 'identity' ? '🏷 Вкажіть назву клубу'
            : warning.repair === 'admins' ? '👥 Додайте owner'
                : warning.repair === 'chat' ? '💬 Додайте чат\n\nУ цей чат бот буде публікувати тренування та приймати записи.'
                    : '📅 Додайте перше тренування до розкладу';
        await this.services.adminUi.show(ctx, title, createSetupStepKeyboard(readiness));
    }
    private async showCheck(ctx: Context, readiness: ClubReadiness): Promise<void> {
        const state = (ok: boolean, warning?: string) => ok ? '✅' : `⚠️${warning ? ` ${warning}` : ''}`;
        await this.services.adminUi.show(ctx, ['✅ Перевірка клубу', '', `Owner: ${state(readiness.ownerConfigured)}`, `Чат: ${state(readiness.chatConfigured, readiness.warnings.find((w) => w.repair === 'chat')?.message)}`, `Розклад: ${state(readiness.scheduleConfigured)}`, `Публікація: ${state(readiness.publicationConfigured, readiness.warnings.find((w) => w.code === 'missing_publication')?.message)}`].join('\n'), createReadinessKeyboard(readiness));
    }
}
