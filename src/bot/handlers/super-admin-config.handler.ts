import { Context, Markup } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { SuperAdminConfigService } from '../../domain/config/super-admin-config.service';
import { ImportedClubConfig } from '../../domain/config/config.types';

const IMPORT_CONFIRM_CALLBACK =
    'super_admin:import:confirm';

const IMPORT_CANCEL_CALLBACK =
    'super_admin:import:cancel';

const IMPORT_HELP_CALLBACK =
    'super_admin:import:help';

const IMPORT_BACK_CALLBACK =
    'super_admin:import:back';

export class SuperAdminConfigHandler {
    constructor(
        private readonly services: ServicesContext,
        private readonly configService: SuperAdminConfigService,
        private readonly superAdminIds: number[],
    ) {}

    async startImport(ctx: Context): Promise<void> {
        const superAdminId =
            this.getSuperAdminId(ctx);

        if (!superAdminId) {
            return;
        }

        this.services.adminFlow.transition(
            superAdminId,
            'waiting_config_import',
        );

        await ctx.reply(
            this.renderImportPrompt(),
            this.createImportKeyboard(),
        );
    }

    async exportConfig(ctx: Context): Promise<void> {
        if (!this.getSuperAdminId(ctx)) {
            return;
        }

        const config =
            await this.configService.exportConfig();

        await ctx.reply(
            [
                '📤 Поточна конфігурація',
                '',
                '```json',
                JSON.stringify(config, null, 2),
                '```',
            ].join('\n'),
            {
                parse_mode: 'Markdown',
            },
        );
    }

    async handleText(ctx: Context): Promise<boolean> {
        const superAdminId =
            this.getSuperAdminId(ctx);

        if (
            !superAdminId ||
            !ctx.message ||
            !('text' in ctx.message)
        ) {
            return false;
        }

        const state =
            this.services.adminFlow.getState(
                superAdminId,
            );

        if (state !== 'waiting_config_import') {
            return false;
        }

        try {
            const config =
                this.configService.parseImportJson(
                    ctx.message.text,
                );

            this.services.adminFlow.setData(
                superAdminId,
                {
                    pendingImport: config,
                },
            );

            await ctx.reply(
                this.renderImportPreview(config),
                this.createImportConfirmationKeyboard(),
            );
        } catch (error) {
            await ctx.reply(
                [
                    '❌ Помилка конфігурації',
                    '',
                    error instanceof Error
                        ? error.message
                        : 'Invalid config',
                    '',
                    'Перевірте JSON або відкрийте опис формату',
                ].join('\n'),
                this.createImportKeyboard(),
            );
        }

        return true;
    }

    async handleCallback(
        ctx: Context,
    ): Promise<boolean> {
        const superAdminId =
            this.getSuperAdminId(ctx);

        if (
            !superAdminId ||
            !ctx.callbackQuery ||
            !('data' in ctx.callbackQuery)
        ) {
            return false;
        }

        const callback =
            ctx.callbackQuery.data;

        if (callback === IMPORT_HELP_CALLBACK) {
            await ctx.answerCbQuery();

            await ctx.editMessageText(
                this.renderImportHelp(),
                {
                    parse_mode: 'HTML',
                    ...this.createImportHelpKeyboard(),
                },
            );

            return true;
        }

        if (callback === IMPORT_BACK_CALLBACK) {
            await ctx.answerCbQuery();

            await ctx.editMessageText(
                this.renderImportPrompt(),
                this.createImportKeyboard(),
            );

            return true;
        }

        if (
            callback === IMPORT_CONFIRM_CALLBACK
        ) {
            await ctx.answerCbQuery();

            const data =
                this.services.adminFlow.getData(
                    superAdminId,
                );

            if (!data.pendingImport) {
                throw new Error(
                    'Pending import not found',
                );
            }

            await this.configService.importConfig(
                data.pendingImport as ImportedClubConfig,
            );

            this.services.adminFlow.reset(
                superAdminId,
            );

            await ctx.editMessageText(
                '✅ Конфігурацію імпортовано',
            );

            return true;
        }

        if (
            callback === IMPORT_CANCEL_CALLBACK
        ) {
            await ctx.answerCbQuery();

            this.services.adminFlow.reset(
                superAdminId,
            );

            await ctx.editMessageText(
                '❌ Імпорт скасовано',
            );

            return true;
        }

        return false;
    }

    private renderImportPrompt(): string {
        return [
            '📦 Імпорт конфігурації',
            '',
            'Надішліть JSON одним повідомленням',
            '',
            'Існуючі шаблони з тим самим днем і часом будуть оновлені',
            'Нові шаблони будуть створені',
        ].join('\n');
    }

    private renderImportHelp(): string {
        const example = {
            club: {
                title: 'Badminton Club',
                timezone: 'Europe/Kyiv',
                chatId: -1001234567890,
                cancelCheckHoursBefore: 4,
            },
            templates: [
                {
                    title: 'Вечірнє тренування',
                    location: 'Зал 1',
                    dayOfWeek: 1,
                    startTime: '19:30',
                    endTime: '21:30',
                    placesLimit: 16,
                    minPlayers: 8,
                    publishDayOfWeek: 7,
                    publishTime: '18:00',
                    enabled: true,
                },
            ],
        };

        return [
            '📖 <b>Формат конфігурації</b>',
            '',
            '<b>club</b> — налаштування клубу',
            '',
            '<code>title</code> — назва клубу',
            '<code>timezone</code> — часовий пояс',
            '<code>chatId</code> — ID групового чату',
            '<code>cancelCheckHoursBefore</code> — за скільки годин перевіряти мінімум гравців',
            '',
            '<b>templates</b> — список тренувань',
            '',
            '<code>title</code> — назва тренування, необовʼязково',
            '<code>location</code> — місце, необовʼязково',
            '<code>dayOfWeek</code> — день тренування, 1 = Пн, 7 = Нд',
            '<code>startTime</code> — час початку HH:mm',
            '<code>endTime</code> — час завершення HH:mm',
            '<code>placesLimit</code> — максимальна кількість місць',
            '<code>minPlayers</code> — мінімум гравців',
            '<code>publishDayOfWeek</code> — день публікації, 1 = Пн, 7 = Нд',
            '<code>publishTime</code> — час публікації HH:mm',
            '<code>enabled</code> — true або false',
            '',
            '<b>Приклад:</b>',
            '',
            `<pre>${this.escapeHtml(
                JSON.stringify(example, null, 2),
            )}</pre>`,
        ].join('\n');
    }

    private renderImportPreview(
        config: ImportedClubConfig,
    ): string {
        return [
            '📦 Імпорт конфігурації',
            '',
            config.club?.title
                ? `🏸 ${config.club.title}`
                : undefined,
            '',
            `Шаблонів: ${
                config.templates?.length ?? 0
            }`,
            '',
            ...(config.templates ?? []).map(
                (template) =>
                    `${
                        template.enabled === false
                            ? '⚪️'
                            : '🟢'
                    } День ${template.dayOfWeek} ${template.startTime}–${template.endTime}`,
            ),
        ]
            .filter(
                (line): line is string =>
                    line !== undefined,
            )
            .join('\n');
    }

    private createImportKeyboard() {
        return Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '📖 Формат конфігурації',
                    IMPORT_HELP_CALLBACK,
                ),
            ],
            [
                Markup.button.callback(
                    '❌ Скасувати',
                    IMPORT_CANCEL_CALLBACK,
                ),
            ],
        ]);
    }

    private createImportHelpKeyboard() {
        return Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '◀️ Назад до імпорту',
                    IMPORT_BACK_CALLBACK,
                ),
            ],
            [
                Markup.button.callback(
                    '❌ Скасувати',
                    IMPORT_CANCEL_CALLBACK,
                ),
            ],
        ]);
    }

    private createImportConfirmationKeyboard() {
        return Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    '✅ Імпортувати',
                    IMPORT_CONFIRM_CALLBACK,
                ),
            ],
            [
                Markup.button.callback(
                    '❌ Скасувати',
                    IMPORT_CANCEL_CALLBACK,
                ),
            ],
        ]);
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private getSuperAdminId(
        ctx: Context,
    ): number | undefined {
        if (
            ctx.chat?.type !== 'private' ||
            !ctx.from ||
            !this.superAdminIds.includes(
                ctx.from.id,
            )
        ) {
            return undefined;
        }

        return ctx.from.id;
    }
}