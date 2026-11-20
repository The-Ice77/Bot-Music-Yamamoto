import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/database.ts';
import { GuildSettingsRepository } from '../../src/db/guildSettingsRepository.ts';

test('openDatabase enables WAL mode and creates all 4 spec tables on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-db-'));
  const dbPath = path.join(dir, 'nested', 'bot.sqlite');
  const db = openDatabase(dbPath);
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r: any) => r.name);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(mode.journal_mode.toLowerCase(), 'wal');
  assert.deepEqual(
    tables.sort(),
    ['active_player_sessions', 'guild_settings', 'lavalink_queues', 'lavalink_sessions'],
  );
});

test('GuildSettingsRepository returns defaults and upserts partial updates', () => {
  const db = openDatabase(':memory:');
  const repo = new GuildSettingsRepository(db);

  const def = repo.getOrDefault('g1');
  assert.deepEqual(
    {
      guildId: def.guildId,
      defaultVolume: def.defaultVolume,
      djRoleId: def.djRoleId,
      musicChannelId: def.musicChannelId,
      autoLeaveSeconds: def.autoLeaveSeconds,
      alwaysOn247: def.alwaysOn247,
      voiceChannelId247: def.voiceChannelId247,
      textChannelId247: def.textChannelId247,
    },
    {
      guildId: 'g1',
      defaultVolume: 80,
      djRoleId: null,
      musicChannelId: null,
      autoLeaveSeconds: 180,
      alwaysOn247: false,
      voiceChannelId247: null,
      textChannelId247: null,
    },
  );

  repo.update('g1', { defaultVolume: 110, djRoleId: 'role-1' });
  const updated = repo.update('g1', { alwaysOn247: true, voiceChannelId247: 'vc-1', textChannelId247: 'tc-1' });
  assert.equal(updated.defaultVolume, 110);
  assert.equal(updated.djRoleId, 'role-1');
  assert.equal(updated.alwaysOn247, true);
  assert.equal(updated.voiceChannelId247, 'vc-1');
  assert.equal(updated.textChannelId247, 'tc-1');

  assert.equal(repo.getAll247Guilds().length, 1);
  repo.clear247Channel('g1');
  assert.equal(repo.getAll247Guilds().length, 0);
  assert.equal(repo.getOrDefault('g1').voiceChannelId247, null);
  assert.equal(repo.getOrDefault('g1').textChannelId247, null);

  const clearedRole = repo.update('g1', { djRoleId: null });
  assert.equal(clearedRole.djRoleId, null);
  assert.equal(repo.getOrDefault('g1').djRoleId, null);
  db.close();
});
