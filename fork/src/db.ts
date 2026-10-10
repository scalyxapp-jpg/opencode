import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type SessionRow = {
  id: string
  project_id: string
  title: string | null
  directory: string | null
  version: string | null
  agent: string | null
  model: string | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  time_created: number
  time_updated: number
}

export const dataDir = (): string => {
  const xdg = Bun.env.XDG_DATA_HOME
  return xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode")
}

export const dbPath = (): string => Bun.env.OPENCODE_DB || join(dataDir(), "opencode.db")

/**
 * Read-only handle. `ocf` must never be able to mutate a live opencode
 * database: a crash mid-write would corrupt 4 GB of session history.
 */
export const open = (path = dbPath()): Database | null => {
  if (!existsSync(path)) return null
  const db = new Database(path, { readonly: true, strict: false })
  db.exec("PRAGMA query_only = 1")
  return db
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0)

export const readSession = (row: Record<string, unknown>): SessionRow => ({
  id: String(row.id ?? ""),
  project_id: String(row.project_id ?? ""),
  title: (row.title as string) ?? null,
  directory: (row.directory as string) ?? null,
  version: (row.version as string) ?? null,
  agent: (row.agent as string) ?? null,
  model: (row.model as string) ?? null,
  cost: row.cost === null ? null : num(row.cost),
  tokens_input: row.tokens_input === null ? null : num(row.tokens_input),
  tokens_output: row.tokens_output === null ? null : num(row.tokens_output),
  tokens_reasoning: row.tokens_reasoning === null ? null : num(row.tokens_reasoning),
  tokens_cache_read: row.tokens_cache_read === null ? null : num(row.tokens_cache_read),
  tokens_cache_write: row.tokens_cache_write === null ? null : num(row.tokens_cache_write),
  time_created: num(row.time_created),
  time_updated: num(row.time_updated),
})

/**
 * v2 is the live table; v1 rows are only returned when no v2 counterpart
 * exists, so `ocf` sees the full history across both schema generations.
 */
export const allSessions = (db: Database, limit = 100000): SessionRow[] => {
  const v2 = db.query("SELECT * FROM session_v2 ORDER BY time_updated DESC LIMIT ?").all(limit as never) as Record<
    string,
    unknown
  >[]
  const seen = new Set(v2.map((r) => String(r.id)))
  const v1 = db.query("SELECT * FROM session ORDER BY time_updated DESC LIMIT ?").all(limit as never) as Record<
    string,
    unknown
  >[]

  return [...v2, ...v1.filter((r) => !seen.has(String(r.id)))].map(readSession)
}

export const tableCount = (db: Database, table: string): number => {
  const exists = db.query("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(table)
  if (!exists) return 0
  return num((db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)
}

const escapeLike = (s: string): string => s.replace(/[%_]/g, (c) => "\\" + c)

export type SearchRow = {
  session_id: string
  message_id: string
  seq: number
  kind: string
  created: number
  data: string
  title: string | null
  directory: string | null
}

const toSearchRow = (r: Record<string, unknown>): SearchRow => ({
  session_id: String(r.session_id ?? ""),
  message_id: String(r.message_id ?? ""),
  seq: num(r.seq),
  kind: String(r.type ?? "text"),
  created: num(r.time_created),
  data: String(r.data ?? ""),
  title: (r.title as string) ?? null,
  directory: (r.directory as string) ?? null,
})

export const searchRows = (db: Database, query: string, opts: { limit?: number; offset?: number } = {}): SearchRow[] =>
  (
    db
      .query(
        `SELECT m.session_id, m.id AS message_id, m.seq, m.type, m.time_created, m.data,
              s.title, s.directory
           FROM session_message m
           LEFT JOIN session_v2 s ON s.id = m.session_id
          WHERE m.data LIKE ? ESCAPE '\\'
          ORDER BY m.time_created DESC
          LIMIT ? OFFSET ?`,
      )
      .all("%" + escapeLike(query) + "%", opts.limit ?? 25, opts.offset ?? 0) as Record<string, unknown>[]
  ).map(toSearchRow)

/** Tiefe Suche: greift auch in Tool-Ergebnisse der part-Tabelle. */
export const searchParts = (db: Database, query: string, limit = 20): SearchRow[] =>
  (
    db
      .query(
        `SELECT session_id, id AS message_id, 0 AS seq, 'part' AS type,
                time_created, data, NULL AS title, NULL AS directory
           FROM part
          WHERE data LIKE ? ESCAPE '\\'
          ORDER BY time_created DESC
          LIMIT ?`,
      )
      .all("%" + escapeLike(query) + "%", limit) as Record<string, unknown>[]
  ).map(toSearchRow)

export const sessionMessages = (db: Database, sessionId: string) =>
  db
    .query("SELECT id, seq, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as Record<string, unknown>[]

export const sessionOf = (db: Database, id: string) => {
  const row = db.query("SELECT * FROM session_v2 WHERE id = ?").get(id) as Record<string, unknown> | null
  return row ? readSession(row) : null
}
