import type { DatabaseSync } from 'node:sqlite';
import type { QueueStoreManager, StoredQueue } from 'lavalink-client';

interface QueueRow {
  queue_json: string;
}

function emptyStoredQueue(): Partial<StoredQueue> {
  return { tracks: [], previous: [] };
}

/**
 * SQLite-backed `QueueStoreManager` implementation storing serialized guild queues in `lavalink_queues`.
 */
export class SqliteQueueStore implements QueueStoreManager {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Fetches the unparsed queue JSON string for `guildId`, or `undefined` when absent.
   */
  async get(guildId: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT queue_json FROM lavalink_queues WHERE guild_id = ?')
      .get(guildId) as QueueRow | undefined;

    return row ? row.queue_json : undefined;
  }

  /**
   * Persists a serialized queue value for `guildId`.
   */
  async set(guildId: string, value: StoredQueue | string): Promise<boolean> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO lavalink_queues (guild_id, queue_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           queue_json = excluded.queue_json,
           updated_at = excluded.updated_at`,
      )
      .run(guildId, serialized, new Date().toISOString());

    return true;
  }

  /**
   * Deletes the stored queue for `guildId`, returning whether a row was removed.
   */
  async delete(guildId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM lavalink_queues WHERE guild_id = ?').run(guildId);
    return Number(result.changes) > 0;
  }

  /**
   * Serializes a `StoredQueue` object to JSON, or passes through an existing JSON string.
   */
  async stringify(value: StoredQueue | string): Promise<string> {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  /**
   * Parses a stored queue string back into a `Partial<StoredQueue>`, degrading safely on missing or corrupt JSON.
   */
  async parse(value: StoredQueue | string | undefined): Promise<Partial<StoredQueue>> {
    if (value === undefined || value === null) {
      return emptyStoredQueue();
    }

    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return emptyStoredQueue();
        }
        return parsed as Partial<StoredQueue>;
      } catch {
        return emptyStoredQueue();
      }
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }

    return emptyStoredQueue();
  }

  /**
   * Removes all persisted guild queues.
   */
  clearAll(): void {
    this.db.prepare('DELETE FROM lavalink_queues').run();
  }
}
