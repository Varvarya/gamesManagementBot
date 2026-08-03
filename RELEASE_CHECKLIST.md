# Release checklist

## Automated checks

- [x] TypeScript typecheck passes.
- [x] All automated tests pass.
- [x] Production build succeeds.
- [x] Empty-data repositories initialize successfully.
- [x] Restart lifecycle test passes.
- [x] Two-chat scheduler isolation is tested.
- [x] Multi-slot templates are tested.
- [x] Scheduler restoration is tested.
- [x] Registration, main list, waitlist, and promotion are tested.
- [x] Insufficient-player cancellation is tested.
- [x] Backup creation and invalid-import rollback are tested.
- [x] Environment validation is implemented.

## Before deployment

- [ ] Use a staging bot to run the Telegram smoke path in `SMOKE_TEST.md`.
- [ ] Confirm the bot can send and edit messages in every configured chat.
- [ ] Confirm delete-message permission if chat cleanup is enabled.
- [ ] Confirm the owner and emergency super-admin IDs.
- [ ] Confirm persistent data and backup volumes.
- [ ] Create and inspect a fresh backup.
- [ ] Review `.env` without sharing the token.
- [ ] Review `USER_GUIDE.md` with the club owner.
- [ ] Tag the release only after the live staging smoke test passes.
