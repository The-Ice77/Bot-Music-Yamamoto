import type { DatabaseSync } from 'node:sqlite';
import type { RepeatMode } from 'lavalink-client';

export interface ActivePlayerSession {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  repeatMode: RepeatMode;
  panelChannelId: string | null;
  panelMessageId: string | null;
  updatedAt: string;
}

interface NodeSessionRow {
  session_id: string;
}

interface ActivePlayerRow {
  guild_id: string;
  voice_channel_id: string;
  text_channel_id: string;
  repeat_mode: string;
  panel_channel_id: string | null;
  panel_message_id: string | null;
  updated_at: string;
}

const ACTIVE_PLAYER_COLUMNS = `
  guild_id,
  voice_channel_id,
  text_channel_id,
  repeat_mode,
  panel_channel_id,
  panel_message_id,
  updated_at
`;

function normalizeRepeatMode(value: string): RepeatMode {
  if (value === 'track' || value === 'queue') {
    return value;
  }
  return 'off';
}

function mapActivePlayerRow(row: ActivePlayerRow): ActivePlayerSession {
  return {
    guildId: row.guild_id,
    voiceChannelId: row.voice_channel_id,
    textChannelId: row.text_channel_id,
    repeatMode: normalizeRepeatMode(row.repeat_mode),
    panelChannelId: row.panel_channel_id,
    panelMessageId: row.panel_message_id,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository for Lavalink node resume session IDs and active guild player bindings.
 */
export class SessionStoreRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Returns the saved Lavalink resume session ID for `nodeId`, or `null` if none exists.
   */
  getNodeSessionId(nodeId: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM lavalink_sessions WHERE node_id = ?')
      .get(nodeId) as NodeSessionRow | undefined;

    return row ? row.session_id : null;
  }

  /**
   * Upserts the Lavalink resume session ID for `nodeId`.
   */
  saveNodeSessionId(nodeId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO lavalink_sessions (node_id, session_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run(nodeId, sessionId, new Date().toISOString());
  }

  /**
   * Deletes the saved Lavalink resume session ID for `nodeId`.
   */
  deleteNodeSessionId(nodeId: string): void {
    this.db.prepare('DELETE FROM lavalink_sessions WHERE node_id = ?').run(nodeId);
  }

  /**
   * Returns the active player session binding for `guildId`, or `null` if none exists.
   */
  getActivePlayer(guildId: string): ActivePlayerSession | null {
    const row = this.db
      .prepare(`SELECT ${ACTIVE_PLAYER_COLUMNS} FROM active_player_sessions WHERE guild_id = ?`)
      .get(guildId) as ActivePlayerRow | undefined;

    return row ? mapActivePlayerRow(row) : null;
  }

  /**
   * Lists all persisted active player sessions across guilds.
   */
  listActivePlayers(): ActivePlayerSession[] {
    const rows = this.db
      .prepare(`SELECT ${ACTIVE_PLAYER_COLUMNS} FROM active_player_sessions`)
      .all() as unknown as ActivePlayerRow[];

    return rows.map(mapActivePlayerRow);
  }

  /**
   * Upserts the active player session binding for a guild and returns the saved record.
   */
  saveActivePlayer(session: Omit<ActivePlayerSession, 'updatedAt'>): ActivePlayerSession {
    const updatedAt = new Date().toISOString();
    const saved: ActivePlayerSession = {
      ...session,
      updatedAt,
    };

    this.db
      .prepare(
        `INSERT INTO active_player_sessions (
           guild_id,
           voice_channel_id,
           text_channel_id,
           repeat_mode,
           panel_channel_id,
           panel_message_id,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           voice_channel_id = excluded.voice_channel_id,
           text_channel_id = excluded.text_channel_id,
           repeat_mode = excluded.repeat_mode,
           panel_channel_id = excluded.panel_channel_id,
           panel_message_id = excluded.panel_message_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        saved.guildId,
        saved.voiceChannelId,
        saved.textChannelId,
        saved.repeatMode,
        saved.panelChannelId,
        saved.panelMessageId,
        saved.updatedAt,
      );

    return saved;
  }

  /**
   * Deletes the active player session binding for `guildId`.
   */
  deleteActivePlayer(guildId: string): void {
    this.db.prepare('DELETE FROM active_player_sessions WHERE guild_id = ?').run(guildId);
  }

  /**
   * Deletes all persisted active player session bindings.
   */
  clearAllActivePlayers(): void {
    this.db.prepare('DELETE FROM active_player_sessions').run();
  }
}
