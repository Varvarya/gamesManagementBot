# Manual test plan: club storage and admin editing

This plan uses only Telegram and filesystem inspection. Do not run test commands in a terminal. Stop and start the deployed bot using the normal hosting controls when a restart is requested.

## Preparation

Use a test bot and a copy of production data. Record `DATA_DIR`, the intended club name, Telegram IDs for an owner and manager, and the expected slug. Never paste the bot token into chat or screenshots.

## New club and first launch

1. Start with an empty `DATA_DIR` and no legacy club-name environment variable.
2. Confirm the bot starts and creates only `_system/clubs.json` and `_system/club-creation-requests.json`.
3. Open `/start` as Super Admin. Confirm the zero-club screen offers direct creation and creation requests.
4. Create `RSP Київ` through Super Admin. Only now confirm `rsp-kyiv/` exists and `default/` does not.
5. Inspect `rsp-kyiv/settings.json`. Confirm `title`, `storageSlug`, `clubId`, timezone, administrators and ISO timestamps are present.
6. Repeat with a normal user request. Confirm no folder exists before approval and the requester becomes owner after approval.

## Legacy `default` migration

1. In the test data copy, place representative settings, chats, templates, trainings, players, and logs under `DATA_DIR/default/`. Set the saved title to `RSP Київ` and omit `storageSlug` to simulate legacy data.
2. Start the bot. Confirm `DATA_DIR/rsp-kyiv/` contains every source file, the JSON files open successfully, and settings now contains `storageSlug: "rsp-kyiv"`.
3. Confirm a timestamped copy exists under `DATA_DIR/.migration-backups/`.
4. Compare file names and representative records (player, chat, template, training) between the legacy/backup data and the new directory.
5. Restart twice. Confirm no duplicate records or additional migrations occur.
6. Repeat with a deliberately non-empty `rsp-kyiv/`. Confirm it is not overwritten and the bot logs a skipped migration result.

## Stable folder on rename

1. In Telegram open Settings → Club name, enter `Новий клуб`, and save.
2. Confirm the refreshed Settings and main menu show `Новий клуб`.
3. Inspect settings: `title` changed, `storageSlug` remains `rsp-kyiv`, and `updatedAt` advanced.
4. Confirm the folder remains `rsp-kyiv/`; no `novyi-klub/` or `default/` appears. Restart and reconfirm.

## Edit-flow matrix

For club name, timezone, chats, templates, template slots, players, trainings, and administrators:

1. Start Edit and confirm the prompt matches the selected entity/field.
2. Send invalid input. Confirm an error is shown and the same flow still accepts corrected input.
3. Press Cancel after another invalid input. Confirm the previous list/detail card returns unchanged.
4. Edit again with valid input. Confirm one success message and a freshly rendered card with the new value.
5. Press an old button from before the edit. Confirm the bot reports an expired/missing item or safely returns; it must not crash.
6. Repeat the same valid action where possible. Confirm Telegram's “message is not modified” condition is silent.
7. Inspect the relevant JSON and confirm exactly one updated entity, valid JSON, and no temporary files remain.

Specific checks: change timezone and verify future template publications/cancellation checks use it after restart; edit a template slot and verify only that slot changes; rename/merge players and verify training participants show fresh names; edit training details and verify its group message refreshes; add/remove an administrator and verify access changes immediately (never remove the last owner/admin).

## Failure and recovery

Temporarily remove the bot's permission to edit a published training message, then edit that training. Confirm Telegram clearly reports the secondary synchronization failure and repository/message state is recoverable after restoring permission and retrying. Also verify malformed callback data and callbacks for deleted entities fail safely.

## Startup diagnostics

Using the hosting log viewer, confirm one occurrence per start of `club.storage_resolved`, `repositories.load_started`, `repositories.load_completed`, and `settings.loaded`. During migration also confirm `club.storage_migration_started` and `club.storage_migration_completed`. Records must include club ID, title, storage slug, and resolved path, and must not contain tokens or player data.
