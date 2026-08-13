# Games Bot

## Production setup

Install Node.js 22, copy `.env.example` to `.env`, and set a BotFather token plus at least one Telegram user ID in `SUPER_ADMIN_IDS`. `DATA_DIR` must be a persistent writable directory. Starting with zero clubs is supported; clubs are created through Super Admin or approved user requests. Run `npm ci`, `npm test`, and `npm run build`.

The first super-admin opens a private chat with the bot and sends `/start`. From the menu, add a group under **Chats** (the bot must already be in that group), then create a template, select the chat, add one or more slots, and enable it. Club owners and managers are managed under **Settings → Administrators**.

Start directly with `npm run start:prod`, or use `docker compose up -d --build`. Compose uses automatic restart, bounded JSON-file logs, a health check, and persistent `bot-data` and `bot-backups` volumes.

## Operations

- Update: create a backup, pull the new version, run `npm ci`, `npm run migration`, `npm test`, `npm run build`, then restart.
- Backup: super-admin `/backup` or `npm run backup`. Backups are timestamped directories with repository JSON files and a manifest; the newest five are retained.
- Restore: stop the bot, run `npm run restore -- <timestamped-backup-directory-or-name>`, then run `npm run migration` and restart. Restore validates checksums and JSON first, creates a safety backup of current data, and rolls back automatically if writing fails. Startup also attempts the latest valid backup automatically.
- Status: use **Settings → Status** or the container health status.

Common startup errors are missing/invalid environment variables, unwritable data volumes, invalid JSON without a usable backup, an invalid timezone, or a Telegram token rejected by BotFather. Registration-message deletion requires group delete permissions; failure is logged and does not break registration.

Import/export remains restricted to configured super-admin IDs. Never commit `.env`, data, backups, or bot tokens.

## Local Telegram group player export

The local exporter uses a Telegram **user account** over MTProto; it does not start the bot and never reads or writes club storage. Create Telegram developer application credentials, then set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. `TELEGRAM_SESSION` is optional.

1. Run `npm run telegram:players-export`.
2. On the first run, enter the phone number, login code, and 2FA password when requested.
3. Choose a visible group or supergroup (`0` cancels safely).
4. Review the generated files under `exports/`.
5. Upload the CSV through **Club Admin → Гравці → Імпорт** and review its import preview.

The reusable session string is saved to the ignored `.telegram-session` file with owner-only permissions. Phone numbers, login codes, passwords, API hash, and session contents are never printed. For repeatable selection, `--chat-id <id>` and `--chat-title <title>` are supported. Telegram may restrict full member enumeration; a partial result is explicitly marked in the CLI summary and raw JSON.
