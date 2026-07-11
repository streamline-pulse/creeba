import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { ChatMessage, Identity } from "../shared/chat.ts";

/**
 * Local portable database (DuckDB), one instance per app. Persistence is the
 * APP's responsibility (creeba-js stores nothing): identity and message history
 * are kept here. It stays fully local: P2P only carries messages, never the DB.
 */
export class ChatDB {
  private constructor(private readonly conn: DuckDBConnection) {}

  static async open(path: string): Promise<ChatDB> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(
      `CREATE TABLE IF NOT EXISTS identity (user_id VARCHAR PRIMARY KEY, name VARCHAR)`
    );
    await conn.run(
      `CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR PRIMARY KEY,
        room VARCHAR,
        user_id VARCHAR,
        name VARCHAR,
        body VARCHAR,
        ts BIGINT
      )`
    );
    return new ChatDB(conn);
  }

  async getOrCreateIdentity(): Promise<Identity> {
    const reader = await this.conn.runAndReadAll(
      `SELECT user_id, name FROM identity LIMIT 1`
    );
    const rows = reader.getRowObjects();
    const first = rows[0];
    if (first) {
      return { userId: String(first.user_id), name: String(first.name) };
    }
    const userId = crypto.randomUUID();
    const name = `user-${userId.slice(0, 4)}`;
    const prepared = await this.conn.prepare(`INSERT INTO identity VALUES ($1, $2)`);
    prepared.bindVarchar(1, userId);
    prepared.bindVarchar(2, name);
    await prepared.run();
    return { userId, name };
  }

  async setName(userId: string, name: string): Promise<void> {
    const prepared = await this.conn.prepare(
      `UPDATE identity SET name = $2 WHERE user_id = $1`
    );
    prepared.bindVarchar(1, userId);
    prepared.bindVarchar(2, name);
    await prepared.run();
  }

  /** Insert a message (idempotent: ignores duplicates received over P2P). */
  async insertMessage(message: ChatMessage): Promise<void> {
    const prepared = await this.conn.prepare(
      `INSERT INTO messages VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`
    );
    prepared.bindVarchar(1, message.id);
    prepared.bindVarchar(2, message.room);
    prepared.bindVarchar(3, message.userId);
    prepared.bindVarchar(4, message.name);
    prepared.bindVarchar(5, message.body);
    prepared.bindBigInt(6, BigInt(message.ts));
    await prepared.run();
  }

  async recentMessages(room: string, limit = 200): Promise<ChatMessage[]> {
    const prepared = await this.conn.prepare(
      `SELECT id, room, user_id, name, body, ts
       FROM messages WHERE room = $1
       ORDER BY ts DESC LIMIT $2`
    );
    prepared.bindVarchar(1, room);
    prepared.bindInteger(2, limit);
    const reader = await prepared.runAndReadAll();
    const rows = reader.getRowObjects();
    return rows
      .map((row) => ({
        id: String(row.id),
        room: String(row.room),
        userId: String(row.user_id),
        name: String(row.name),
        body: String(row.body),
        ts: Number(row.ts),
      }))
      .reverse();
  }
}
