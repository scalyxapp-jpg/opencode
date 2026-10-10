/**
 * Erzeugt Vorschläge für den nächsten Schritt aus dem Session-Kontext.
 *
 * Der Modellaufruf läuft über `session.generate`, das den Session-Kontext nutzt,
 * ohne die Session zu verändern — ein Vorschlag darf den Verlauf nicht berühren.
 */

import type { SessionMessageInfo } from "@opencode/client"

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

/**
 * Was in dieser Session tatsächlich passiert ist.
 *
 * Grundlage sind ausschließlich die Tool-Aufrufe und Assistenten-Aussagen im
 * Verlauf. Das ist die einzige Quelle, die die TUI belastbar hat: der Server
 * liefert weder Todos noch einen Git-Diff, und `VcsInfo` kennt nur den Branch.
 */
export type Evidence = {
  /** Turns im betrachteten Fenster. */
  turns: number
  /** Turns in der ganzen Session — als Maßstab, wie viel vorher passierte. */
  totalTurns: number
  files: string[]
  commands: string[]
  failures: Array<{ tool: string; target: string; error: string }>
  lastClaim: string
}

const FILE_TOOLS = new Set(["read", "edit", "write", "patch", "glob", "grep"])
const SHELL_TOOLS = new Set(["bash", "shell"])

/**
 * Wie viele Turns zurück die Belege reichen.
 *
 * Eine Session kann hunderte Turns umfassen. Für "was ist der nächste Schritt"
 * zählt die aktuelle Arbeit, nicht der Anfang der Session: in einer Session mit
 * 1352 Turns über 105 Dateien lagen die ersten zwölf Dateien im Rückblick
 * vollständig daneben — keine einzige war noch aktuell.
 */
const EVIDENCE_WINDOW = 40

const stringField = (input: Record<string, unknown> | undefined, keys: string[]): string => {
  if (!input) return ""
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

const clipField = (value: string, max = 120): string => (value.length > max ? value.slice(0, max - 1) + "…" : value)

/** Sammelt Belege, neueste zuerst. Rein lesend, damit es ohne Kontext testbar bleibt. */
export function collectEvidence(
  messages: ReadonlyArray<SessionMessageInfo>,
  maxFiles = 12,
  maxCommands = 8,
  window = EVIDENCE_WINDOW,
): Evidence {
  const assistant = messages.filter((message) => message.type === "assistant")
  // Das Fenster zählt Assistenten-Turns, nicht Rohzeilen: eine lange Session
  // enthält viele Nutzer- und Systemzeilen dazwischen.
  const recent = assistant.slice(-window)

  const files: string[] = []
  const commands: string[] = []
  const failures: Evidence["failures"] = []
  let lastClaim = ""

  const add = (list: string[], value: string, max: number) => {
    if (value && !list.includes(value) && list.length < max) list.push(value)
  }

  // Rückwärts, damit die Grenzen von den neuesten Einträgen verbraucht werden.
  for (let index = recent.length - 1; index >= 0; index--) {
    const message = recent[index]!
    const content = message.content ?? []

    if (!lastClaim) {
      const text = content
        .filter(
          (block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n\n")
        .trim()
      if (text) lastClaim = clipField(text, 400)
    }

    for (const block of content) {
      if (block.type !== "tool") continue
      const state = block.state
      const input = state.input as Record<string, unknown> | undefined
      const target = stringField(input, ["filePath", "path", "pattern", "url"])

      if (FILE_TOOLS.has(block.name)) add(files, target, maxFiles)
      if (SHELL_TOOLS.has(block.name)) add(commands, clipField(stringField(input, ["command", "cmd"]), 100), maxCommands)

      if (state.status === "error" && failures.length < 6) {
        failures.push({
          tool: block.name,
          target: clipField(target || stringField(input, ["command"]), 70),
          error: clipField(state.error.message, 140),
        })
      }
    }
  }

  return { turns: recent.length, totalTurns: assistant.length, files, commands, failures, lastClaim }
}


/** Baut den Auftrag samt Belegblock. Ohne Belege bleibt nur der Verlauf. */
export function buildPrompt(evidence: Evidence, focus?: string): string {
  const lines: string[] = [`Turns in dieser Session: ${evidence.totalTurns}, davon betrachtet: ${evidence.turns}`]
  if (evidence.files.length) lines.push(`Zuletzt angefasste Dateien (neueste zuerst): ${evidence.files.join(", ")}`)
  if (evidence.commands.length)
    lines.push(`Zuletzt ausgeführte Befehle (neueste zuerst): ${evidence.commands.join(" | ")}`)
  if (evidence.failures.length) {
    lines.push("Fehlgeschlagene Aufrufe (neueste zuerst):")
    for (const failure of evidence.failures) {
      lines.push(`  - ${failure.tool} auf ${failure.target || "?"}: ${failure.error}`)
    }
  }
  // Als Zitat mit Anführungszeichen: ein nackter Satz am Blockende lädt das
  // Modell ein, den Verlauf fortzusetzen statt zu antworten.
  if (evidence.lastClaim) lines.push(`Letzte Aussage, wörtliches Zitat: ${JSON.stringify(evidence.lastClaim)}`)
  if (lines.length === 1) lines.push("Keine abgeschlossenen Arbeitsschritte im Verlauf.")

  // Die Anweisung steht vorne und wird hinten wiederholt: die Belegliste in der
  // Mitte soll das Format nicht überschreiben.
  const task = [
    "AUFGABE: Nenne drei bis vier nächste Arbeitsschritte.",
    "Regeln:",
    "1. Jeder Schritt muss sich auf einen Punkt der Belege unten stützen können.",
    "2. Erfinde keine Dateien, Funktionen, Tests oder Probleme, die dort nicht stehen.",
    "3. Wenn die Belege keinen sinnvollen Schritt hergeben, gib ein leeres Array zurück.",
    focus ? `4. Besonderes Augenmerk: ${focus}` : "",
    "",
    "BELEGE (nur diese, keine Annahmen darüber hinaus):",
    lines.join("\n"),
    "",
    'Antworte jetzt ausschließlich mit einem JSON-Array der Form [{"title":"…","detail":"…"}].',
    "Kein Codezaun, kein Vorwort, keine Wiederholung dieser Anweisung.",
    "Das erste Zeichen deiner Antwort ist [ und das letzte ].",
  ].filter((line) => line !== undefined)

  return task.join("\n")
}

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
