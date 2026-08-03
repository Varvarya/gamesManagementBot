import { Context, Markup } from 'telegraf';
import { ServicesContext } from '../../app/services.context';
import { SuperAdminConfigService } from '../../domain/config/super-admin-config.service';
import { ImportedClubConfig } from '../../domain/config/config.types';
import { ImportPreview } from '../../domain/config/config.types';
import { AdminFlowState } from '../admin/flows/admin-flow.types';

const IMPORT_CONFIRM_CALLBACK =
    'super_admin:import:confirm';

const IMPORT_CANCEL_CALLBACK =
    'super_admin:import:cancel';

const IMPORT_HELP_CALLBACK =
    'super_admin:import:help';

const IMPORT_BACK_CALLBACK =
    'super_admin:import:back';

export class SuperAdminConfigHandler {
    readonly messageStates: readonly AdminFlowState[] = ['waiting_config_import'];
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

        await this.services.adminUi.show(
            ctx,
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

        const date = new Date().toISOString().slice(0, 10);
        const message = await ctx.replyWithDocument(
            { source: Buffer.from(`${JSON.stringify(config, null, 2)}\n`), filename: `club-config-${date}.json` },
            { caption: '📤 Конфігурацію експортовано' },
        );
        if (ctx.chat?.type === 'private' && ctx.from) this.services.adminUi.trackBotMessage(ctx.from.id, ctx.chat.id, message.message_id);
    }

    async createBackup(ctx: Context): Promise<void> {
        if (!this.getSuperAdminId(ctx)) return;
        try {
            const result = await this.configService.createBackup();
            await this.services.adminUi.notice(ctx, `✅ Резервну копію створено\nФайлів: ${result.files.length}\n${result.directory}`);
        } catch (error) {
            await this.services.adminUi.notice(ctx, `❌ ${error instanceof Error ? error.message : 'Не вдалося створити резервну копію'}`);
        }
    }

    canHandleMessage(adminId: number): boolean {
        return this.services.adminFlow.getState(adminId) === 'waiting_config_import';
    }

    async handleMessage(ctx: Context): Promise<boolean> {
        const superAdminId =
            this.getSuperAdminId(ctx);

        if (!superAdminId || !ctx.message) {
            return false;
        }

        if (!this.canHandleMessage(superAdminId)) {
            return false;
        }

        try {
            const json = 'text' in ctx.message
                ? ctx.message.text
                : 'document' in ctx.message
                    ? await this.readImportDocument(ctx, ctx.message.document)
                    : undefined;
            if (!json) return false;
            const config =
                this.configService.parseImportJson(
                    json,
                );
            const preview = await this.configService.previewImport(config);

            this.services.adminFlow.setData(
                superAdminId,
                {
                    pendingImport: config,
                },
            );

            await this.services.adminUi.show(
                ctx,
                this.renderImportPreview(config, preview),
                this.createImportConfirmationKeyboard(),
            );
        } catch (error) {
            await this.services.adminUi.show(
                ctx,
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
            'Надішліть JSON одним повідомленням або файлом до 1 МБ.',
            '',
            'Перед збереженням ви побачите всі зміни.',
            'Перед перезаписом бот автоматично створить резервну копію.',
        ].join('\n');
    }

    private renderImportHelp(): string {
        const example = {
            schemaVersion: 1,
            data: {
                settings: { clubId: 'club', title: 'Клуб', timezone: 'Europe/Kyiv', admins: [], cleanChatMode: true, createdAt: '...', updatedAt: '...' },
                chats: [{ id: -1001234567890, name: 'Група клубу', enabled: true }],
                players: [],
                templates: [],
            },
        };

        return [
            '📖 <b>Формат конфігурації</b>',
            '',
            'Найбезпечніше імпортувати файл, який бот створив командою /export.',
            'Файл містить налаштування, чати, гравців і розклади.',
            'Перед підтвердженням бот покаже кількість доданих, змінених і видалених записів.',
            'Перед перезаписом автоматично створюється резервна копія.',
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
        preview: ImportPreview,
    ): string {
        if (preview.mode === 'snapshot') {
            return [
                '📦 Перевірте зміни',
                '',
                `⚙️ Налаштування: ${preview.settingsChanged ? 'будуть оновлені' : 'без змін'}`,
                renderSection('💬 Чати', preview.chats),
                renderSection('👥 Гравці', preview.players),
                renderSection('📅 Розклади', preview.templates),
                '',
                'Елементи, яких немає у файлі, буде видалено.',
                'Перед імпортом буде створено резервну копію.',
            ].join('\n');
        }
        return [
            '📦 Перевірте зміни (старий формат)',
            '',
            config.club?.title
                ? `🏸 ${config.club.title}`
                : undefined,
            '',
            `Шаблонів: ${
                config.templates?.length ?? 0
            }`,
            'Чати та гравці не зміняться.',
            'Перед імпортом буде створено резервну копію.',
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

    private async readImportDocument(ctx: Context, document: { file_id: string; file_size?: number; file_name?: string; mime_type?: string }): Promise<string> {
        if ((document.file_size ?? 0) > 1_000_000) throw new Error('Файл завеликий. Максимальний розмір — 1 МБ.');
        if (document.file_name && !document.file_name.toLowerCase().endsWith('.json')) throw new Error('Надішліть файл у форматі JSON.');
        const url = await ctx.telegram.getFileLink(document.file_id);
        const response = await fetch(url);
        if (!response.ok) throw new Error('Не вдалося завантажити файл. Спробуйте ще раз.');
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error('Файл завеликий. Максимальний розмір — 1 МБ.');
        return text;
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

function renderSection(title: string, section: ImportPreview['chats']): string {
    return `${title}: ${section.incoming} після імпорту  ·  +${section.added}  ~${section.updated}  −${section.removed}`;
}
