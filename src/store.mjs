import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

/**
 * SQLite message store for the WhatsApp emulator.
 * Stores messages per session so they survive restarts.
 */
export class MessageStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content     TEXT NOT NULL,
        msg_type    TEXT NOT NULL DEFAULT 'text',
        metadata    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
    `);

    this._insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, role, content, msg_type, metadata, created_at)
      VALUES (@id, @sessionId, @role, @content, @msgType, @metadata, @createdAt)
    `);

    this._selectStmt = this.db.prepare(`
      SELECT id, session_id, role, content, msg_type, metadata, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `);

    this._clearStmt = this.db.prepare(`DELETE FROM messages WHERE session_id = ?`);
  }

  /**
   * Save a message. Silently ignores duplicates (same id).
   */
  save(sessionId, msg) {
    this._insertStmt.run({
      id: msg.id,
      sessionId,
      role: msg.from === "user" ? "user" : "assistant",
      content: msg.text || msg.body || "",
      msgType: msg.msgType || "text",
      metadata: JSON.stringify(msg),
      createdAt: new Date(msg.timestamp || Date.now()).toISOString(),
    });
  }

  /**
   * Get all messages for a session, ordered by time.
   */
  getHistory(sessionId) {
    return this._selectStmt.all(sessionId).map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      msg_type: row.msg_type,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
    }));
  }

  /**
   * Clear all messages for a session.
   */
  clearSession(sessionId) {
    this._clearStmt.run(sessionId);
  }

  close() {
    this.db.close();
  }
}
