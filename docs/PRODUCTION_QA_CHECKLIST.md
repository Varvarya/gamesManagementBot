# Telegram badminton bot — manual production QA

Use a test bot and a copy of production data. For every case record date, tester, result and screenshot/log reference. Never use the real bot token in evidence.

## New User

- [ ] **Precondition:** Telegram user absent from all clubs. **Steps:** `/start`. **Expected:** welcome with “Приєднатися” and “Створити”; both buttons work without an admin check.
- [ ] **Precondition:** zero, one, then several enabled clubs. **Steps:** choose Join. **Expected:** useful empty state for zero; direct usable choice for one; non-empty selector for many.
- [ ] **Precondition:** user belongs to one admin club, several admin clubs, or member-only club. **Steps:** clear/restart bot session; `/start`. **Expected:** one admin club restores Club Admin; several show selector; member sees member context, never new-user onboarding.
- [ ] **Precondition:** pending/rejected/approved request. **Steps:** `/start`, inspect request, edit/cancel where allowed. **Expected:** status and next action are clear; no dead end.

## Club Admin

- [ ] **Precondition:** admin of Club A but not B. **Steps:** enter A, use every root item; try an old B callback. **Expected:** A works; stale/wrong-club callback says the menu is inactive and performs no mutation.
- [ ] **Precondition:** two admins. **Steps:** one edits while the other saves an older form. **Expected:** newer data is not silently overwritten; conflict is reported (record as release blocker if absent).
- [ ] **Precondition:** temporary edit active. **Steps:** invalid value, Back, Cancel, repository failure. **Expected:** flow remains recoverable or clears only temporary data; mode and active club remain unchanged.

## Owner

- [ ] **Precondition:** owner and admin entries use numeric and string legacy IDs. **Steps:** restart and open admin menu. **Expected:** IDs normalize; both roles have access; owner remains owner.
- [ ] **Precondition:** one owner plus admins. **Steps:** attempt to remove final owner, then final administrator. **Expected:** both are blocked until a replacement owner/admin exists.

## Super Admin

- [ ] **Precondition:** configured Super Admin absent from all `settings.admins`. **Steps:** `/start`; list/search/view clubs, activity, problems and requests. **Expected:** access succeeds solely from Super Admin config; zero states are meaningful.
- [ ] **Precondition:** pending club request. **Steps:** approve twice; repeat with rejection. **Expected:** first review is persisted and idempotent; requester becomes owner only on approval; no folder exists before approval.
- [ ] **Precondition:** two same/similar club titles. **Steps:** create/approve. **Expected:** storage slugs are unique and deterministic or collision is clearly blocked before partial creation.
- [ ] **Precondition:** enabled club with jobs. **Steps:** disable, enable, then delete using exact-name confirmation. **Expected:** disable preserves files and stops actions; delete backs up before registry/storage removal; repeated callback is safe.
- [ ] **Precondition:** Super Admin root. **Steps:** enter club explicitly, then return explicitly. **Expected:** old UI is removed, navigation resets, repository/settings/session IDs match, and old buttons are stale.

## Players

- [ ] **Precondition:** known, Telegram, manual-unconfirmed, inactive players and aliases. **Steps:** search, rename, confirm, deactivate/reactivate. **Expected:** correct player is shown and persisted; manual unknown player is `confirmed=false`, `active=true` and needs no Telegram account.
- [ ] **Precondition:** two duplicate players in historical/active/waitlist trainings. **Steps:** merge. **Expected:** every `playerId` points to target, no training has duplicate target entries, display snapshots remain readable, aliases/Telegram identity are retained.
- [ ] **Precondition:** unknown name while adding to training. **Steps:** search, create, confirm. **Expected:** player is created once and added immediately; retry does not duplicate it.

## Chats

- [ ] **Precondition:** Club A has one chat; B has two. **Steps:** switch A/B/A and open Chats/statistics. **Expected:** counts/data are 1 and 2 with no leakage; load failure displays unavailable, not zero.
- [ ] **Precondition:** chat used by a template. **Steps:** attempt deletion. **Expected:** deletion is blocked with referenced-template explanation until reassigned/removed.
- [ ] **Precondition:** bot lacks send/edit/delete permission or was removed. **Steps:** run diagnostics and refresh publication. **Expected:** actionable permanent/transient status; no crash or repeated spam.

## Templates

- [ ] **Precondition:** chat exists. **Steps:** create; edit name, five weekday slots with different times, limits, minimum, publication, chat; Preview/Back/Cancel/Confirm. **Expected:** only Confirm persists; admins and active club stay unchanged.
- [ ] **Precondition:** five enabled slots. **Steps:** edit/delete one; restart twice. **Expected:** one job per enabled slot; unrelated slots remain; removed slot job disappears; no duplicates.

## Trainings

- [ ] **Precondition:** training in each lifecycle state. **Steps:** try valid and invalid transitions. **Expected:** draft→open, open→closed/cancelled, closed→finished, finished→archived; impossible transitions are rejected without mutation.
- [ ] **Precondition:** public message deleted/stale or bot cannot edit. **Steps:** change training then republish/recover. **Expected:** scheduler stays alive; stale reference is diagnosed and recovery is possible.
- [ ] **Precondition:** minimum 8 with 7 then 8 places. **Steps:** reach scheduled check. **Expected:** 7 cancels once at check; 8 continues; merely restarting never triggers overdue cancellation.

## Registration

- [ ] **Precondition:** open training. **Steps:** send `+1`…`+4` and `+1 Name`…`+4 Name`. **Expected:** one entry reserves 1–4 places; rendering numbers each place as player then `+1` lines.
- [ ] **Precondition:** entry has four places in active and then waitlist. **Steps:** `-1`, `-2`, `-3`, `-4`. **Expected:** remaining places are 3/2/1/removed according to the original state; only public list refreshes.
- [ ] **Precondition:** limit 12, occupied 10. **Steps:** register `+4`, retry same update concurrently. **Expected:** entire entry is waitlisted, capacity never exceeds 12, and no duplicate entry appears.
- [ ] **Precondition:** free 2; queue A+3, B+1, C+2. **Steps:** free places by cancel/decrement/admin removal and raise limit. **Expected:** B is promoted, then C only if it fits; A keeps its queue position; capacity is never exceeded.

## Scheduler

- [ ] **Precondition:** future and overdue publication/minimum jobs. **Steps:** stop before/after each deadline; restart offline and online. **Expected:** future jobs restore once; overdue destructive jobs are held for explicit reconciliation; no duplicate publish/cancel.
- [ ] **Precondition:** simulated ENOTFOUND, ETIMEDOUT, ECONNRESET, 429, harmless 400 and 403. **Steps:** trigger publish/edit. **Expected:** transient errors back off/retry, harmless errors are ignored, permanent errors become diagnostics; domain data remains recoverable.

## Restart / Recovery

- [ ] **Precondition:** valid populated club. **Steps:** restart during each waiting flow and after every mutation. **Expected:** persisted domain state is identical; temporary flow may reset safely; known admin is recovered from stored settings.
- [ ] **Precondition:** missing, empty, invalid, partial and future-schema JSON; valid backup where applicable. **Steps:** start. **Expected:** missing initializes only a genuinely new repository; corrupt data recovers only from validated backup or startup fails without overwriting it.
- [ ] **Precondition:** legacy numeric admins, timestamps, places, chats and display snapshots. **Steps:** start twice and compare files. **Expected:** one backed-up idempotent migration to canonical schema; second start makes no changes.

## Permissions

- [ ] **Precondition:** Super Admin, owner, admin and outsider. **Steps:** run the same club-admin callbacks in each mode and use stale old-mode buttons. **Expected:** first three authorized per scope, outsider denied, stale buttons never execute; Back never changes role/mode.
- [ ] **Precondition:** clean chat enabled. **Steps:** conduct private flow and group conversation. **Expected:** only tracked bot/admin-flow UI is cleaned; arbitrary group/user history is untouched; delete failure is non-fatal.

## Multi-club isolation

- [ ] **Precondition:** A has uniquely named player/chat/template/training; B has different entities; C empty. **Steps:** A→B→C→A repeatedly, including concurrent admins and scheduler restart. **Expected:** `session.activeClubId`, repository ID and settings ID always match; no screen, mutation, statistic or job crosses clubs.
