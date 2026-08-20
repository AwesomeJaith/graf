import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.GRAF_DB_PATH ?? join(__dirname, "..", "..", "..", "..", ".data", "graf.db")

let db: Database.Database | undefined

/** Chat history lives here, not in HydraDB — it's application/session state, not enterprise knowledge the retrieval pipeline should ever traverse. */
export function getDb(): Database.Database {
  if (db) return db
  mkdirSync(dirname(DB_PATH), { recursive: true })
  db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, position);
  `)
  return db
}
