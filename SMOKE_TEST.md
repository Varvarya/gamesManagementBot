# First-release smoke test

Date: 2026-08-02

Automated lifecycle result: **passed** with real persisted JSON repositories and a mocked Telegram transport.

Verified path:

1. Empty club data initialized.
2. Admin-equivalent chat creation persisted.
3. A two-slot template was created and linked to the chat.
4. Template scheduler restored two jobs after restart.
5. A training was published through the Telegram transport adapter.
6. Players filled the main list and created a waitlist.
7. One participant cancelled and the first waitlisted player was promoted.
8. An administrator-equivalent participant removal succeeded.
9. Template publication time was edited and both jobs were rescheduled.
10. An insufficient-player training was cancelled and its message updated.
11. A repository backup was created.
12. A second restart restored chats, template slots, participants, and statuses.

Live Telegram verification remains a deployment step because it requires a staging bot, real group permissions, and Bot API access. Follow the unchecked staging steps in `RELEASE_CHECKLIST.md` before tagging the release.
