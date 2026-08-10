import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClubRepository } from '../storage/repositories/club.repository';
import { JsonStorage } from '../storage/jsonStorage';
import { RepositoriesContext } from '../app/repositories.context';
import { ServicesContext } from '../app/services.context';

test('production lifecycle persists club, owner, chat, template, training, players and registrations across restart', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gamesbot-smoke-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clubs = new ClubRepository(root);
    const club = await clubs.create({ name: 'Smoke Club', firstAdminTelegramId: 101 });
    const storage = new JsonStorage({ dataDir: root, storageSlug: club.slug });
    const repositories = new RepositoriesContext(storage, 'Europe/Kyiv', { clubId: club.id, title: club.name, storageSlug: club.slug });
    await repositories.loadAll();
    const services = new ServicesContext(repositories);
    await services.chats.create({ id: -1001, name: 'Main' });
    const template = await services.templates.create({ clubId: club.id, chatId: -1001, title: 'Friday', placesLimit: 12, minPlayers: 8, publishDaysBefore: 1, publishTime: '18:00', slots: [{ dayOfWeek: 5, startTime: '19:00', endTime: '21:00' }], enabled: true });
    const draft = await services.trainings.createDraft({ clubId: club.id, chatId: -1001, templateId: template.id, templateSlotId: template.slots[0].id, title: template.title, date: '2030-08-16', startTime: '19:00', endTime: '21:00', placesLimit: 5, minPlayers: 0 });
    await services.trainings.publish({ trainingId: draft.id, messageId: 777 });
    const player = await services.players.createUnconfirmedByAdmin('Новий гравець');
    await services.trainingParticipants.addParticipant({ trainingId: draft.id, playerId: player.id, displayName: player.displayName, places: 4, source: 'admin' });
    await services.trainingParticipants.removeParticipant({ trainingId: draft.id, playerId: player.id, requestedPlacesToRemove: 2 });
    const queued = await services.players.createUnconfirmedByAdmin('Черга');
    assert.equal((await services.trainingParticipants.addParticipant({ trainingId: draft.id, playerId: queued.id, displayName: queued.displayName, places: 4, source: 'admin' })).outcome, 'waitlisted');

    const restarted = new RepositoriesContext(new JsonStorage({ dataDir: root, storageSlug: club.slug }), 'Europe/Kyiv', { clubId: club.id, title: club.name, storageSlug: club.slug });
    await restarted.loadAll();
    assert.equal((await restarted.settings.get()).admins[0].role, 'owner');
    assert.equal((await restarted.chats.getAll()).length, 1);
    assert.equal((await restarted.templates.list()).length, 1);
    const persisted = await restarted.trainings.findById(draft.id);
    assert.equal(persisted?.participants[0].places, 2);
    assert.equal(persisted?.waitlist[0].places, 4);
    assert.equal((await restarted.players.list()).length, 2);
});
