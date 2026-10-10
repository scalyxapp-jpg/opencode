import { open, allSessions, type SessionRow } from "./db.ts"
import { ago, bold, count, dim, heading, money, table } from "./format.ts"

export type Group = "day" | "model" | "project" | "agent"
export type LedgerOpts = { group?: Group; days?: number; limit?: number }

type Bucket = {
  key: string
  sessions: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  last: number
}

const empty = (key: string): Bucket => ({
  key,
  sessions: 0,
  cost: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  last: 0,
})

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const modelLabel = (raw: string | null): string => {
  if (!raw) return "(unbekannt)"
  try {
    const m = JSON.parse(raw) as { providerID?: string; id?: string; variant?: string }
    const id = m.id ?? "?"
    const variant = m.variant ? `:${m.variant}` : ""
    return `${m.providerID ?? "?"}/${id}${variant}`
  } catch {
    return raw.slice(0, 40)
  }
}

const keyFor = (s: SessionRow, group: Group): string => {
  if (group === "day") return dayKey(s.time_updated)
  if (group === "model") return modelLabel(s.model)
  if (group === "agent") return s.agent ?? "(unbekannt)"
  return (s.directory ?? "(kein Verzeichnis)").replace(process.env.HOME ?? "/home/x", "~")
}

export const ledger = async (opts: LedgerOpts = {}): Promise<number> => {
  const db = open()
  if (!db) {
    console.error("Keine opencode-Datenbank gefunden. Nutze OPENCODE_DB.")
    return 1
  }

  const group: Group = opts.group ?? "day"
  const days = opts.days ?? 30
  const cutoff = Date.now() - days * 86_400_000
  const sessions = allSessions(db).filter((s) => s.time_updated >= cutoff)

  const buckets = new Map<string, Bucket>()
  for (const s of sessions) {
    const key = keyFor(s, group)
    const b = buckets.get(key) ?? empty(key)
    b.sessions += 1
    b.cost += s.cost ?? 0
    b.input += s.tokens_input ?? 0
    b.output += s.tokens_output ?? 0
    b.reasoning += s.tokens_reasoning ?? 0
    b.cacheRead += s.tokens_cache_read ?? 0
    b.cacheWrite += s.tokens_cache_write ?? 0
    b.last = Math.max(b.last, s.time_updated)
    buckets.set(key, b)
  }

  const rows = [...buckets.values()]
  const totalCost = rows.reduce((a, b) => a + b.cost, 0)
  const totals = rows.reduce(
    (a, b) => ({
      input: a.input + b.input,
      output: a.output + b.output,
      reasoning: a.reasoning + b.reasoning,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheWrite: a.cacheWrite + b.cacheWrite,
      sessions: a.sessions + b.sessions,
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 },
  )

  const limit = opts.limit ?? (group === "day" ? days : 15)
  const sorted = rows
    .sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : b.cost - a.cost || b.last - a.last))
    .slice(0, limit)

  console.log(heading(`ocf ledger — letzte ${days} Tage, gruppiert nach ${group}`))

  if (rows.length === 0) {
    console.log(`\n  ${dim("Keine Sessions im Zeitraum.")}\n`)
    return 0
  }

  const body = sorted.map((b) => {
    const label = group === "day" ? b.key : b.key.length > 34 ? "…" + b.key.slice(-33) : b.key
    return [
      label,
      String(b.sessions),
      money(b.cost),
      count(b.input),
      count(b.output),
      count(b.reasoning),
      count(b.cacheRead),
      b.cost > 0 ? ((b.cost / totalCost) * 100).toFixed(1) + "%" : "—",
      ago(b.last),
    ] as [string, ...string[]]
  })

  console.log()
  console.log(
    table([
      [
        bold("GRUPPE"),
        bold("SESS"),
        bold("KOSTEN"),
        bold("IN"),
        bold("OUT"),
        bold("THINK"),
        bold("CACHE"),
        bold("SHARE"),
        bold("LETZTE"),
      ],
      ...body,
    ]),
  )

  const cacheRatio = totals.cacheRead + totals.input > 0 ? totals.cacheRead / (totals.cacheRead + totals.input) : 0
  console.log(
    `\n${table([
      ["Sessions", String(totals.sessions)],
      ["Kosten gesamt", `${money(totalCost)} ${dim(group === "day" ? ` (${days} Tage)` : "")}`],
      ["Tokens in/out", `${count(totals.input)} / ${count(totals.output)}`],
      ["Reasoning", count(totals.reasoning)],
      ["Cache read", `${count(totals.cacheRead)} ${dim(`(${(cacheRatio * 100).toFixed(1)} % vom Prompt-Volumen)`)}`],
      ["Cache write", count(totals.cacheWrite)],
    ])}\n`,
  )

  if (cacheRatio < 0.2 && totals.cacheRead > 0) {
    console.log(
      dim(
        "  ↳ Cache-Hit-Rate niedrig — Anthropic-Routen mit ephemeralem Cache-Prompt profitieren von stabilen Präfixen.\n",
      ),
    )
  } else if (cacheRatio >= 0.5) {
    console.log(dim("  ↳ Cache-Hit-Rate hoch — die Systempräfixe werden gut wiederverwendet.\n"))
  }
  return 0
}
