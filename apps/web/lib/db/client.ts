import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { terminalResult } from "../trace-types"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * A serverless deployment has a read-only filesystem apart from `/tmp`, so the
 * repo-relative default can't be created there at all. `/tmp` survives for the
 * life of a warm instance, which is enough for chat history to behave normally
 * within a session — but it is per-instance and not durable, so a hosted demo
 * can lose old threads. Persisting them properly means a hosted database, which
 * is a bigger change than the demo needs.
 */
const DEFAULT_DB_PATH = process.env.VERCEL
  ? "/tmp/graf.db"
  : join(__dirname, "..", "..", "..", "..", ".data", "graf.db")
const DB_PATH = process.env.GRAF_DB_PATH ?? DEFAULT_DB_PATH

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

  // A pending turn can't outlive the request that created it: nothing resumes
  // one, so any row still flagged pending when this process opens the file is
  // from a request that died — a dev-server restart, a crash, a closed tab.
  // Left alone it's a permanent spinner in an old thread, since `pending` is
  // persisted and the client trusts what it loads. Safe to do unconditionally
  // because this runs once per process, before any request can have written a
  // pending row of its own.
  db.prepare("UPDATE messages SET pending = 0, result_json = ? WHERE pending = 1").run(
    JSON.stringify(terminalResult("Interrupted before this finished."))
  )

  return db
}
