import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  default_volume INTEGER NOT NULL DEFAULT 80,
  dj_role_id TEXT NULL,
  music_channel_id TEXT NULL,
  auto_leave_seconds INTEGER NOT NULL DEFAULT 180,
  always_on_247 INTEGER NOT NULL DEFAULT 0,
  voice_channel_id_247 TEXT NULL,
  text_channel_id_247 TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lavalink_sessions (
  node_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lavalink_queues (
  guild_id TEXT PRIMARY KEY,
  queue_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_player_sessions (
  guild_id TEXT PRIMARY KEY,
  voice_channel_id TEXT NOT NULL,
  text_channel_id TEXT NOT NULL,
  repeat_mode TEXT NOT NULL DEFAULT 'off',
  panel_channel_id TEXT NULL,
  panel_message_id TEXT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Opens a SQLite database with WAL mode, busy timeout, and all bot schema tables initialized.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  return db;
}
