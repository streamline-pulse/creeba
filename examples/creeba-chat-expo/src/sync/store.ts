import * as SQLite from "expo-sqlite";
import type { ChatMessage, Profile } from "./types";

/**
 * Local mobile database (expo-sqlite). Persistence is the APP's responsibility
 * (creeba-js stores nothing): identity and message history are kept here. The
 * database stays local; P2P only carries messages.
 */
function genId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface MessageRow {
  id: string;
  room: string;
  user_id: string;
  name: string;
  body: string;
  ts: number;
}

export class SqliteStore {
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(name = "creeba.db"): Promise<SqliteStore> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS identity (user_id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room TEXT,
        user_id TEXT,
        name TEXT,
        body TEXT,
        ts INTEGER
      );
    `);
    return new SqliteStore(db);
  }

  async getOrCreateIdentity(): Promise<Profile> {
    const row = await this.db.getFirstAsync<{ user_id: string; name: string }>(
      `SELECT user_id, name FROM identity LIMIT 1`,
    );
    if (row) return { userId: row.user_id, name: row.name };
    const userId = genId();
    const name = `user-${userId.slice(0, 4)}`;
    await this.db.runAsync(`INSERT INTO identity (user_id, name) VALUES (?, ?)`, userId, name);
    return { userId, name };
  }

  async setName(userId: string, name: string): Promise<void> {
    await this.db.runAsync(`UPDATE identity SET name = ? WHERE user_id = ?`, name, userId);
  }

  async insertMessage(m: ChatMessage): Promise<void> {
    await this.db.runAsync(
      `INSERT OR IGNORE INTO messages (id, room, user_id, name, body, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      m.id,
      m.room,
      m.userId,
      m.name,
      m.body,
      m.ts,
    );
  }

  async recentMessages(room: string, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.db.getAllAsync<MessageRow>(
      `SELECT id, room, user_id, name, body, ts FROM messages WHERE room = ? ORDER BY ts DESC LIMIT ?`,
      room,
      limit,
    );
    return rows
      .map((r) => ({
        id: r.id,
        room: r.room,
        userId: r.user_id,
        name: r.name,
        body: r.body,
        ts: Number(r.ts),
      }))
      .reverse();
  }
}
