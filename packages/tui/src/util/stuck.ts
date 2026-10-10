import type { SessionMessageInfo } from "@opencode/client"

/** FNV-1a: stabiler, fester Größe — auch für sehr große Tool-Eingaben. */
const hash = (value: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

export type StuckReport = {
  tool: string
  attempts: number
  error: string
  messageID: string
  /** gekürzte Eingabe für die Anzeige */
  target: string
}

const describe = (input: Record<string, unknown> | undefined): string => {
  if (!input) return ""
  for (const key of ["filePath", "path", "command", "url", "pattern", "name"]) {
    const value = input[key]
    if (typeof value === "string" && value) return value
  }
  return ""
}

/**
 * Erkennt einen festgefahrenen Agenten: dasselbe Tool mit derselben Eingabe
 * scheitert mehrfach in Folge.
 *
 * Bewusst zählen nur Fehlschläge. Dieselbe Eingabe, die erfolgreich war, ist kein
 * Signal — in der Praxis wiederholt der Agent `read` und `edit` dieselbe Datei
 * hundertfach erfolgreich, weil er daran iteriert. Nur die Kombination aus
 * gleicher Eingabe und Fehler ist ein Feststurz.
 */
export function stuckTool(messages: ReadonlyArray<SessionMessageInfo>, threshold = 3): StuckReport | undefined {
  let previous:
    | { key: string; tool: string; error: string; messageID: string; input: Record<string, unknown> | undefined }
    | undefined
  let runs = 0

  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const block of message.content ?? []) {
      if (block.type !== "tool") continue
      const state = block.state
      const key = `${block.name}:${hash(canonical(state.input ?? {}))}`

      // Ein Erfolg mit identischer Eingabe widerlegt den Feststurz.
      if (state.status !== "error") {
        if (previous && key === previous.key) previous = undefined
        runs = 0
        continue
      }

      const input = state.input as Record<string, unknown> | undefined
      if (!previous || key !== previous.key) {
        previous = { key, tool: block.name, error: state.error.message, messageID: message.id, input }
        runs = 1
        continue
      }

      runs += 1
      previous.error = state.error.message
      if (runs >= threshold) {
        return {
          tool: previous.tool,
          attempts: runs,
          error: previous.error,
          messageID: previous.messageID,
          target: describe(previous.input),
        }
      }
    }
  }

  return undefined
}
