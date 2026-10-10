/**
 * Erzeugt Vorschläge für den nächsten Schritt aus dem Session-Kontext.
 *
 * Der Modellaufruf läuft über `session.generate`, das den Session-Kontext nutzt,
 * ohne die Session zu verändern — ein Vorschlag darf den Verlauf nicht berühren.
 */

export type Suggestion = {
  title: string
  detail: string
}

export type ParsedSuggestions = {
  suggestions: Suggestion[]
  /** Wie die Antwort gelesen wurde — für Fehlersuche und Tests. */
  shape: "json" | "list" | "raw" | "empty"
}

const MAX_TITLE = 120
const MAX_DETAIL = 240

export const instructions = [
  "Du schlägst dem Nutzer konkrete nächste Arbeitsschritte für dieses Projekt vor.",
  "Stütze dich ausschließlich auf den bisherigen Gesprächsverlauf und den Projektstand.",
  "Keine Werkzeuge aufrufen, keine Aktionen ausführen, keine Rückfragen stellen.",
  "Antworte ausschließlich mit einem JSON-Array, ohne Codezaun und ohne erklärenden Text.",
  'Jedes Element hat genau zwei Felder: "title" und "detail".',
  '"title" ist ein knapper Imperativ von höchstens 60 Zeichen, zum Beispiel "Fehlerpfad in readFilesystem abdecken".',
  '"detail" ist ein Satz, der begründet, warum dieser Schritt jetzt sinnvoll ist.',
  "Gib drei bis vier Vorschläge, nach Nutzen sortiert.",
].join(" ")

/** Extrahiert das erste JSON-Array aus einer Antwort, auch aus einem Codezaun. */
const extractArray = (text: string): unknown[] | undefined => {
  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text)
  const candidate = fenced?.[1] ?? sliceBalanced(text)
  if (!candidate) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Schneidet ab der ersten `[` bis zur passenden `]` — ohne bei Strings zu zählen. */
function sliceBalanced(text: string): string | undefined {
  const start = text.indexOf("[")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "[") depth++
    if (char === "]") {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** Zweite Stufe: eine Markdown-Liste, falls das Modell kein JSON geliefert hat. */
const fromList = (text: string): Suggestion[] =>
  text
    .split("\n")
    .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line.length > 0)
    .map((line) => {
      const split = /^(.*?)\s*[—–:]\s+(.*)$/.exec(line)
      return split
        ? { title: clip(split[1]!.trim(), MAX_TITLE), detail: clip(split[2]!.trim(), MAX_DETAIL) }
        : { title: clip(line, MAX_TITLE), detail: "" }
    })

/**
 * Liest die Modellantwort. Drei Stufen, weil Modelle sich nicht zuverlässig an
 * das Format halten: JSON, dann Markdown-Liste, dann der Rohtext als ein
 * Vorschlag. Ein leeres Ergebnis ist besser als ein erfundener Vorschlag.
 */
export function parseSuggestions(text: string): ParsedSuggestions {
  const trimmed = text.trim()
  if (!trimmed) return { suggestions: [], shape: "empty" }

  const array = extractArray(trimmed)
  if (array) {
    const suggestions = array
      .map((item) => {
        if (typeof item === "string") {
          const value = item.trim()
          return value ? { title: clip(value, MAX_TITLE), detail: "" } : undefined
        }
        if (!item || typeof item !== "object") return undefined
        const record = item as Record<string, unknown>
        const title = asString(record.title) || asString(record.name) || asString(record.step)
        if (!title) return undefined
        return {
          title: clip(title, MAX_TITLE),
          detail: clip(asString(record.detail) || asString(record.reason) || asString(record.why), MAX_DETAIL),
        }
      })
      .filter((item): item is Suggestion => item !== undefined)

    if (suggestions.length > 0) return { suggestions: suggestions.slice(0, 6), shape: "json" }
  }

  const listed = fromList(trimmed)
  if (listed.length >= 2) return { suggestions: listed.slice(0, 6), shape: "list" }

  return { suggestions: [{ title: clip(trimmed, MAX_TITLE), detail: "" }], shape: "raw" }
}

/** Form, die der Auswahl-Dialog erwartet. Eigener Typ, damit die Zuordnung prüfbar ist. */
export type SuggestOption = {
  title: string
  description: string | undefined
  value: Suggestion
  category: string
}

export const toOptions = (suggestions: readonly Suggestion[]): SuggestOption[] =>
  suggestions.map((suggestion) => ({
    title: suggestion.title,
    description: suggestion.detail || undefined,
    value: suggestion,
    category: "Vorschlag",
  }))
