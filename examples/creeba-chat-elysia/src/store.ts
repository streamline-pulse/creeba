import { Database } from "bun:sqlite";

/** A chat message (payload carried over CreebaSync's `data` channel). */
export interface ChatMessage {
  id: string;
  room: string;
  userId: string;
  name: string;
  body: string;
  ts: number;
}

/** Local node profile. */
export interface Identity {
  userId: string;
  name: string;
}

/**
 * Local node database (bun:sqlite, native to Bun). Persistence is the APP's
 * responsibility (creeba-js stores nothing): identity + message history. It
 * stays fully local to the server: P2P only carries messages, never the DB.
 */
export class SqliteStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS identity (user_id TEXT PRIMARY KEY, name TEXT)`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room TEXT,
        user_id TEXT,
        name TEXT,
        body TEXT,
        ts INTEGER
      )`,
    );
  }

  async getOrCreateIdentity(): Promise<Identity> {
    const row = this.db
      .query("SELECT user_id, name FROM identity LIMIT 1")
      .get() as { user_id: string; name: string } | null;
    if (row) return { userId: row.user_id, name: row.name };

    const userId = crypto.randomUUID();
    const name = `user-${userId.slice(0, 4)}`;
    this.db
      .query("INSERT INTO identity (user_id, name) VALUES (?, ?)")
      .run(userId, name);
    return { userId, name };
  }

  async setName(userId: string, name: string): Promise<void> {
    this.db
      .query("UPDATE identity SET name = ? WHERE user_id = ?")
      .run(name, userId);
  }

  /**
   * Insert a message (idempotent: ignores duplicates received over P2P).
   * Returns `true` if the row was actually inserted (new), `false` if ignored.
   */
  async insertMessage(message: ChatMessage): Promise<boolean> {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO messages (id, room, user_id, name, body, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.room,
        message.userId,
        message.name,
        message.body,
        message.ts,
      );
    return res.changes > 0;
  }

  async recentMessages(room: string, limit = 200): Promise<ChatMessage[]> {
    const rows = this.db
      .query(
        `SELECT id, room, user_id, name, body, ts
         FROM messages WHERE room = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(room, limit) as MessageRow[];
    return rows.map(fromRow).reverse();
  }

  /** Highest known timestamp for a room (the local backfill cursor); 0 if empty. */
  latestTs(room: string): number {
    const row = this.db
      .query(`SELECT MAX(ts) AS m FROM messages WHERE room = ?`)
      .get(room) as { m: number | null } | null;
    return row?.m ?? 0;
  }

  /**
   * Messages at or after `since` (ascending). Uses `>=` so the boundary message
   * is included; the receiver dedups by `id`, so no message is ever missed.
   */
  messagesSince(room: string, since: number, limit = 1000): ChatMessage[] {
    const rows = this.db
      .query(
        `SELECT id, room, user_id, name, body, ts
         FROM messages WHERE room = ? AND ts >= ?
         ORDER BY ts ASC LIMIT ?`,
      )
      .all(room, since, limit) as MessageRow[];
    return rows.map(fromRow);
  }
}

interface MessageRow {
  id: string;
  room: string;
  user_id: string;
  name: string;
  body: string;
  ts: number;
}

const fromRow = (r: MessageRow): ChatMessage => ({
  id: r.id,
  room: r.room,
  userId: r.user_id,
  name: r.name,
  body: r.body,
  ts: Number(r.ts),
});
