import type { DatabaseSync } from 'node:sqlite';

export interface GuildSettings {
  guildId: string;
  defaultVolume: number;
  djRoleId: string | null;
  musicChannelId: string | null;
  autoLeaveSeconds: number;
  alwaysOn247: boolean;
  voiceChannelId247: string | null;
  textChannelId247: string | null;
  updatedAt: string;
}

export type GuildSettingsPatch = Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>;

interface GuildSettingsRow {
  guild_id: string;
  default_volume: number;
  dj_role_id: string | null;
  music_channel_id: string | null;
  auto_leave_seconds: number;
  always_on_247: number;
  voice_channel_id_247: string | null;
  text_channel_id_247: string | null;
  updated_at: string;
}

const SELECT_COLUMNS = `
  guild_id,
  default_volume,
  dj_role_id,
  music_channel_id,
  auto_leave_seconds,
  always_on_247,
  voice_channel_id_247,
  text_channel_id_247,
  updated_at
`;

function mapRow(row: GuildSettingsRow): GuildSettings {
  return {
    guildId: row.guild_id,
    defaultVolume: row.default_volume,
    djRoleId: row.dj_role_id,
    musicChannelId: row.music_channel_id,
    autoLeaveSeconds: row.auto_leave_seconds,
    alwaysOn247: Boolean(row.always_on_247),
    voiceChannelId247: row.voice_channel_id_247,
    textChannelId247: row.text_channel_id_247,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository for per-guild music configuration stored in `guild_settings`.
 */
export class GuildSettingsRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Returns persisted settings for `guildId`, or default values when none exist yet.
   */
  getOrDefault(guildId: string): GuildSettings {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM guild_settings WHERE guild_id = ?`)
      .get(guildId) as GuildSettingsRow | undefined;

    if (row) {
      return mapRow(row);
    }

    return {
      guildId,
      defaultVolume: 80,
      djRoleId: null,
      musicChannelId: null,
      autoLeaveSeconds: 180,
      alwaysOn247: false,
      voiceChannelId247: null,
      textChannelId247: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Merges a partial update over current or default settings and upserts the row.
   */
  update(guildId: string, patch: GuildSettingsPatch): GuildSettings {
    const current = this.getOrDefault(guildId);
    const updatedAt = new Date().toISOString();
    const merged: GuildSettings = {
      guildId,
      defaultVolume: patch.defaultVolume !== undefined ? patch.defaultVolume : current.defaultVolume,
      djRoleId: patch.djRoleId !== undefined ? patch.djRoleId : current.djRoleId,
      musicChannelId: patch.musicChannelId !== undefined ? patch.musicChannelId : current.musicChannelId,
      autoLeaveSeconds:
        patch.autoLeaveSeconds !== undefined ? patch.autoLeaveSeconds : current.autoLeaveSeconds,
      alwaysOn247: patch.alwaysOn247 !== undefined ? patch.alwaysOn247 : current.alwaysOn247,
      voiceChannelId247:
        patch.voiceChannelId247 !== undefined ? patch.voiceChannelId247 : current.voiceChannelId247,
      textChannelId247:
        patch.textChannelId247 !== undefined ? patch.textChannelId247 : current.textChannelId247,
      updatedAt,
    };

    this.db
      .prepare(
        `INSERT INTO guild_settings (
          guild_id,
          default_volume,
          dj_role_id,
          music_channel_id,
          auto_leave_seconds,
          always_on_247,
          voice_channel_id_247,
          text_channel_id_247,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
          default_volume = excluded.default_volume,
          dj_role_id = excluded.dj_role_id,
          music_channel_id = excluded.music_channel_id,
          auto_leave_seconds = excluded.auto_leave_seconds,
          always_on_247 = excluded.always_on_247,
          voice_channel_id_247 = excluded.voice_channel_id_247,
          text_channel_id_247 = excluded.text_channel_id_247,
          updated_at = excluded.updated_at`,
      )
      .run(
        merged.guildId,
        merged.defaultVolume,
        merged.djRoleId,
        merged.musicChannelId,
        merged.autoLeaveSeconds,
        merged.alwaysOn247 ? 1 : 0,
        merged.voiceChannelId247,
        merged.textChannelId247,
        merged.updatedAt,
      );

    return merged;
  }

  /**
   * Lists all guilds with 24/7 mode enabled and a configured 24/7 voice channel.
   */
  getAll247Guilds(): GuildSettings[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM guild_settings
         WHERE always_on_247 = 1 AND voice_channel_id_247 IS NOT NULL`,
      )
      .all() as unknown as GuildSettingsRow[];

    return rows.map(mapRow);
  }

  /**
   * Clears persisted 24/7 voice and text channel references for a guild.
   */
  clear247Channel(guildId: string): void {
    this.db
      .prepare(
        `UPDATE guild_settings
         SET voice_channel_id_247 = NULL, text_channel_id_247 = NULL, updated_at = ?
         WHERE guild_id = ?`,
      )
      .run(new Date().toISOString(), guildId);
  }
}
