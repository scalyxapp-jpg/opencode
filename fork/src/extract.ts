/**
 * Message-Extraktion aus den JSON-`data`-Blobs der opencode-Datenbank.
 *
 * Real v2-Shapes (aus 400 Samples der Live-DB):
 *   user       { text, time }
 *   assistant  { agent, model, content: [{type: "reasoning"|"text"|"tool", ...}], cost, tokens, finish }
 *   compaction { reason, recent, status, summary, time }
 */

export type ContentBlock = {
  type: string
  text?: string
  name?: string
  state?: { status?: string; input?: unknown; output?: string; error?: string }
}

export type MessagePayload = {
  text?: string
  agent?: string
  model?: { providerID?: string; id?: string; variant?: string }
  content?: ContentBlock[]
  cost?: number
  summary?: string
  error?: { name?: string; data?: { message?: string } }
}

export const parse = (data: string): MessagePayload | null => {
  try {
    return JSON.parse(data) as MessagePayload
  } catch {
    return null
  }
}

/** Alles, was ein Mensch in der UI lesen würde — ohne Tool-JSON und ohne Reasoning. */
export const visibleText = (data: string): string => {
  const m = parse(data)
  if (!m) return data
  const own = [m.text, m.summary].filter((s): s is string => typeof s === "string" && s.length > 0)
  const fromContent = (m.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
  return [...own, ...fromContent].join("\n\n")
}

/** Reasoning + Tool-Ergebnisse — nur für `--deep`-Suchen relevant. */
export const deepText = (data: string): string => {
  const m = parse(data)
  if (!m) return ""
  const out: string[] = []
  for (const b of m.content ?? []) {
    if (b.type === "reasoning" && b.text) out.push(b.text)
    if (b.type === "tool") {
      out.push(b.name ?? "tool")
      if (b.state?.output) out.push(b.state.output)
      if (b.state?.error) out.push(b.state.error)
    }
  }
  return out.join("\n")
}

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim()

export const snippet = (text: string, query: string, width = 220): string => {
  const flat = collapse(text)
  if (flat.length <= width) return flat
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return flat.slice(0, width) + "…"
  const from = Math.max(0, at - Math.floor(width / 3))
  return (from > 0 ? "…" : "") + flat.slice(from, from + width) + (from + width < flat.length ? "…" : "")
}

export const modelLabel = (m: MessagePayload["model"] | string | null): string => {
  const raw = typeof m === "string" ? m : m ? `${m.providerID ?? "?"}/${m.id ?? "?"}` : null
  if (!raw) return "—"
  try {
    const p = JSON.parse(raw) as MessagePayload["model"]
    return `${p?.providerID ?? "?"}/${p?.id ?? "?"}${p?.variant ? ":" + p.variant : ""}`
  } catch {
    return raw
  }
}

export const toolSummary = (b: ContentBlock): string | null => {
  if (b.type !== "tool") return null
  const status = b.state?.status ?? "?"
  const input = b.state?.input
  const hint =
    input && typeof input === "object"
      ? Object.entries(input as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string" && v.length < 90)
          .slice(0, 2)
          .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 60)}`)
          .join(" ")
      : ""
  return `\`${b.name ?? "tool"}\` ${status}${hint ? " · " + hint : ""}`
}
