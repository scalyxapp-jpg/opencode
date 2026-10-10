import { open, searchRows, searchParts, type SearchRow } from "./db.ts"
import { visibleText, deepText, snippet, collapse, modelLabel } from "./extract.ts"
import { ago, bold, cyan, dim, heading, padEnd } from "./format.ts"

export type RecallOpts = {
  limit?: number
  since?: number
  project?: string
  parts?: boolean
  deep?: boolean
}

type Hit = {
  row: SearchRow
  text: string
  score: number
}

const relPath = (dir: string | null): string => (dir ?? "?").replace(process.env.HOME ?? "/home/x", "~")

const scoreOf = (row: SearchRow, query: string, deep: boolean): number => {
  const q = query.toLowerCase()
  const text = (deep ? visibleText(row.data) + "\n" + deepText(row.data) : visibleText(row.data)).toLowerCase()
  if (!text.includes(q)) return 0
  const hits = text.split(q).length - 1
  const kindBonus = row.kind === "user" ? 3 : row.kind === "assistant" ? 2 : 1
  return hits * 2 + kindBonus
}

const render = (hit: Hit, index: number, query: string): string => {
  const { row } = hit
  const where = relPath(row.directory)
  const title = (row.title ?? "(ohne Titel)").slice(0, 44)
  return (
    `${dim(String(index).padStart(3) + ".")} ${bold(cyan(row.session_id.slice(0, 12)))} ` +
    `${dim(ago(row.created).padStart(13))} ${padEnd(row.kind, 10)} ${dim(title)}\n` +
    `      ${dim(where)}\n` +
    `      ${snippet(hit.text, query)}\n`
  )
}

export const recall = async (query: string, opts: RecallOpts = {}): Promise<number> => {
  const db = open()
  if (!db) {
    console.error("Keine opencode-Datenbank gefunden. Nutze OPENCODE_DB.")
    return 1
  }
  const q = query.trim()
  if (!q) {
    console.error("Suchbegriff fehlt: ocf recall <begriff>")
    return 1
  }

  const limit = opts.limit ?? 20
  const deep = opts.deep ?? false

  // over-fetch: filters and scoring run after the SQL window
  const candidates = searchRows(db, q, { limit: Math.max(200, limit * 20) })
  const pool = opts.parts ? [...candidates, ...searchParts(db, q, 100)] : candidates

  let hits: Hit[] = pool
    .filter((r) => !opts.project || relPath(r.directory).toLowerCase().includes(opts.project.toLowerCase()))
    .filter((r) => !opts.since || r.created >= (opts.since as number))
    .map((row) => {
      const text = deep ? visibleText(row.data) + "\n" + deepText(row.data) : visibleText(row.data)
      return { row, text, score: scoreOf(row, q, deep) }
    })
    .filter((h) => h.score > 0 && collapse(h.text).length > 0)
    .sort((a, b) => b.score - a.score || b.row.created - a.row.created)
    .slice(0, limit)

  // Treffer lagen nur in Tool-Eingaben oder Reasoning -> automatisch tiefer suchen
  const escalated = hits.length === 0 && !deep
  if (escalated) {
    hits = pool
      .filter((r) => !opts.project || relPath(r.directory).toLowerCase().includes(opts.project.toLowerCase()))
      .filter((r) => !opts.since || r.created >= (opts.since as number))
      .map((row) => {
        const text = visibleText(row.data) + "\n" + deepText(row.data)
        return { row, text, score: scoreOf(row, q, true) }
      })
      .filter((h) => h.score > 0 && collapse(h.text).length > 0)
      .sort((a, b) => b.score - a.score || b.row.created - a.row.created)
      .slice(0, limit)
  }

  console.log(heading(`ocf recall — "${q}"`))
  console.log(
    dim(
      `  ${candidates.length} Kandidaten aus ${pool.length} Zeilen · ${
        escalated
          ? "automatisch auf Tiefensuche erweitert (nur Tool-/Reasoning-Treffer)"
          : deep
            ? "Tiefensuche (inkl. Reasoning + Tool-Output)"
            : "nur sichtbarer Text"
      }${opts.parts ? " · + part-Tabelle" : ""}`,
    ),
  )

  if (hits.length === 0) {
    console.log(`\n  ${dim("Keine Treffer.")}\n`)
    return 0
  }

  console.log()
  hits.forEach((h, i) => console.log(render(h, i + 1, q)))

  const first = hits[0]!
  console.log(dim(`\n  ${hits.length} Treffer`))
  console.log(dim(`  weitersetzen:  opencode --session ${first.row.session_id}`))
  console.log(dim(`  exportieren:   ocf export ${first.row.session_id} -o session.md\n`))
  return 0
}

export { modelLabel }
