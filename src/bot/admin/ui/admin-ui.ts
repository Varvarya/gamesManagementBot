import { Context, Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';

export type AdminKeyboard =
    Markup.Markup<InlineKeyboardMarkup>;

export class AdminUi {
    async show(
        ctx: Context,
        text: string,
        keyboard?: AdminKeyboard,
    ): Promise<void> {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(
                text,
                keyboard,
            );

            return;
        }

        await ctx.reply(
            text,
            keyboard,
        );
    }

    async notice(
        ctx: Context,
        text: string,
    ): Promise<void> {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery(text);
            return;
        }

        await ctx.reply(text);
    }

    async replaceWithSuccess(
        ctx: Context,
        text: string,
        keyboard?: AdminKeyboard,
    ): Promise<void> {
        await this.show(
            ctx,
            [
                '✅ Готово',
                '',
                text,
            ].join('\n'),
            keyboard,
        );
    }

    async replaceWithError(
        ctx: Context,
        text: string,
        keyboard?: AdminKeyboard,
    ): Promise<void> {
        await this.show(
            ctx,
            [
                '❌ Помилка',
                '',
                text,
            ].join('\n'),
            keyboard,
        );
    }
}