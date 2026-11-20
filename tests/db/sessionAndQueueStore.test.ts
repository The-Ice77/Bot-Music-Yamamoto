import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/database.ts';
import { SessionStoreRepository } from '../../src/db/sessionStoreRepository.ts';
import { SqliteQueueStore } from '../../src/db/sqliteQueueStore.ts';

test('SessionStoreRepository manages node sessionId and active player bindings', () => {
  const db = openDatabase(':memory:');
  const repo = new SessionStoreRepository(db);

  assert.equal(repo.getNodeSessionId('main'), null);
  repo.saveNodeSessionId('main', 'sess-abc');
  assert.equal(repo.getNodeSessionId('main'), 'sess-abc');
  repo.saveNodeSessionId('main', 'sess-xyz');
  assert.equal(repo.getNodeSessionId('main'), 'sess-xyz');
  repo.deleteNodeSessionId('main');
  assert.equal(repo.getNodeSessionId('main'), null);

  assert.equal(repo.getActivePlayer('g1'), null);
  const saved = repo.saveActivePlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    repeatMode: 'queue',
    panelChannelId: 'tc1',
    panelMessageId: 'msg1',
  });
  assert.equal(saved.guildId, 'g1');
  assert.equal(typeof saved.updatedAt, 'string');
  assert.equal(repo.getActivePlayer('g1')?.repeatMode, 'queue');
  assert.equal(repo.getActivePlayer('g1')?.panelMessageId, 'msg1');

  repo.saveActivePlayer({
    guildId: 'g2',
    voiceChannelId: 'vc2',
    textChannelId: 'tc2',
    repeatMode: 'off',
    panelChannelId: null,
    panelMessageId: null,
  });
  assert.equal(repo.listActivePlayers().length, 2);

  repo.deleteActivePlayer('g2');
  assert.equal(repo.getActivePlayer('g2'), null);
  assert.equal(repo.listActivePlayers().length, 1);

  repo.clearAllActivePlayers();
  assert.equal(repo.listActivePlayers().length, 0);
  db.close();
});

test('SqliteQueueStore persists, parses, deletes, and handles corrupt JSON safely', async () => {
  const db = openDatabase(':memory:');
  const store = new SqliteQueueStore(db);

  // Verify lavalink-client prototype method requirement
  const protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  for (const key of ['get', 'set', 'delete', 'stringify', 'parse']) {
    assert.ok(protoKeys.includes(key), `Expected ${key} on SqliteQueueStore prototype`);
  }

  assert.equal(await store.get('missing'), undefined);
  assert.deepEqual(await store.parse(undefined), { tracks: [], previous: [] });

  const sample = {
    current: { encoded: 'abc', info: { title: 'Song 1' } },
    previous: [],
    tracks: [{ encoded: 'def', info: { title: 'Song 2' } }],
  };
  const serialized = await store.stringify(sample as any);
  await store.set('g1', serialized);

  const raw = await store.get('g1');
  assert.equal(typeof raw, 'string');
  const parsed = await store.parse(raw);
  assert.equal(parsed.current?.info?.title, 'Song 1');
  assert.equal(parsed.tracks?.length, 1);
  assert.deepEqual(parsed.previous, []);

  // Review Focus #3: corrupt queue_json degrades to empty queue without throwing
  await store.set('g-bad', '{broken-json');
  const badRaw = await store.get('g-bad');
  const safeParsed = await store.parse(badRaw);
  assert.deepEqual(safeParsed, { tracks: [], previous: [] });

  // Non-object JSON also degrades safely
  await store.set('g-arr', '[]');
  assert.deepEqual(await store.parse(await store.get('g-arr')), { tracks: [], previous: [] });

  await store.delete('g1');
  assert.equal(await store.get('g1'), undefined);

  store.clearAll();
  assert.equal(await store.get('g-bad'), undefined);
  assert.equal(await store.get('g-arr'), undefined);
  db.close();
});
