# Production invariants

These rules are correctness constraints, not UI conventions. A handler must stop safely when it cannot prove them.

## Authorization

- A configured Super Admin passes `super_admin` and `club_admin` authorization without appearing in a club's settings.
- An owner is always a club administrator. Persisted administrators use `{ telegramUserId, role: "owner" | "admin" }`; legacy numeric/string IDs are normalized.
- Club authorization is scoped to the selected club. UI/navigation mode never grants or removes authority.

## Club context and isolation

- In `CLUB_ADMIN`, `session.activeClubId === repositories.clubId === settings.clubId` before every read or mutation.
- Players, chats, templates, trainings, settings and jobs belong to one club. A context mismatch is a hard, user-visible stop.
- Services must not capture a repository belonging to a different club.

## Navigation and temporary flows

- Back changes only the screen stack. Mode changes only through an explicit mode-switch callback.
- Entering a mode clears old navigation and tracked UI. Callbacks from another mode are stale and do not execute.
- Finishing/cancelling clears only flow data; it preserves mode, active club, authorization and repository context.

## Persistence and scheduling

- A successful domain mutation means its atomic JSON write completed. Failed writes do not alter repository cache.
- Invalid/corrupt data is never replaced with defaults. A validated backup may be read; otherwise startup fails clearly.
- Timestamps are ISO 8601. Migrations are backed up and idempotent.
- Startup restores future jobs only. Overdue publication/minimum-check work requires explicit reconciliation and is never executed destructively while booting.
- Registration capacity is `sum(entry.places)`. One entry is wholly active or wholly waitlisted; promotion skips entries that do not fit without reordering the queue itself.

## Telegram boundary

- Every callback is at most 64 UTF-8 bytes and maps to exactly one handler.
- Duplicate updates and publications are idempotent. Telegram delivery failure cannot masquerade as a persisted domain success.
- Missing/stale messages and safe Telegram edit/delete failures are non-fatal and recoverable.
