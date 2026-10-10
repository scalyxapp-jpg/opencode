/**
 * Prompt-Analyse für die Composer-Footerzeile.
 *
 * Bewusst regelbasiert und ohne LLM: ein Rewrite riskiert, die Absicht zu
 * verschieben, und kostet bei jedem Tastendruck einen Aufruf. Die Regeln stammen
 * aus der Session-Historie, nicht aus Bauchgefühl.
 */

export type Anchor = "path" | "symbol" | "none"

export type Finding = {
  level: "warn" | "info"
  code: "no-anchor" | "anchor-missing" | "too-short" | "too-long" | "no-criteria"
  message: string
}

/**
 * Pfadähnliche Referenz — bewusst eng.
 *
 * Zwei Formen zählen: ein Pfad mit mindestens einem Schrägstrich
 * (`packages/tui/src`, `/home/x/proj/main.py`) oder ein Dateiname mit bekannter
 * Endung (`package.json`). Der erste Entwurf war `[\w.-]+` ohne Schrägstrich und
 *matchte jedes Wort im Satz — damit wäre jede Verankerungsprüfung wertlos.
 */
const PATH =
  /(?:\.{1,2}\/)?\/?[\w-]+(?:\/[\w.-]+)+\/?|[\w-]+\.(?:json|tsx|jsx|mjs|cjs|html|toml|yaml|lock|ts|js|py|md|go|rs|yml|txt|sh|sql|css)(?![a-z])/g
/** Code-Referenz: `foo()`, Type::method, Type.member, #123 */
const SYMBOL =
  /(?:^|[\s"'`])`[^`]+`|\b[A-Z][a-zA-Z0-9]*\.[a-zA-Z_$][\w$]*|\b[A-Z][a-zA-Z0-9]*::[a-zA-Z_]\w*|\b[a-zA-Z_$][\w$]*\(\)/
/** Formulierungen, die ein überprüfbares Ergebnis nahelegen. */
const CRITERIA =
  /\b(soll|muss|erwartet|kriterien?|fertig|erfolg|passiert|nachweis|verify|should|must|expect|criteria|done|so dass|damit)\b/i

export type PromptVerdict = {
  text: string
  anchor: Anchor
  references: string[]
  missing: string[]
  findings: Finding[]
}

/** Wie die Historie dieser Installation es sieht — als Begründung, nicht als Gesetz. */
const ANCHOR_HINT = "(Median 5 statt 1 Fehler)"

const VERBATIM_COMMANDS = /^\s*\//

/** Unterhalb dieser Länge ist ein Prompt eine Rückfrage, kein Auftrag. */
const TASK_LENGTH = 80

/**
 * Schwelle der Warnung, kalibriert an der tatsächlichen Historie:
 *
 *   Prompt-Länge   unverankert
 *   0–40 Zeichen     99 %
 *   40–100           96 %
 *   100–250          86 %
 *   250–1000         50 %
 *   code-nah         28 %
 *
 * Kurze Eingaben sind Rückfragen ("weiter", "mach das") — dort wäre jede
 * Verankerungsmahnung Rauschen. Erst ab TASK_LENGTH lohnt der Hinweis, und er
 * bleibt bewusst nur ein Hinweis. Eine harte Warnung gibt es nur bei
 * `anchor-missing`: eine genannte Datei, die es nicht gibt, ist eindeutig falsch.
 */
export function analyzePrompt(text: string, exists?: (reference: string) => boolean): PromptVerdict {
  const trimmed = text.trim()

  if (!trimmed || VERBATIM_COMMANDS.test(trimmed)) {
    return { text: trimmed, anchor: "none", references: [], missing: [], findings: [] }
  }

  const references: string[] = []
  for (const match of trimmed.matchAll(PATH)) {
    const value = match[0]
    if (value && !references.includes(value)) references.push(value)
  }
  const anchor: Anchor = references.length > 0 ? "path" : SYMBOL.test(trimmed) ? "symbol" : "none"
  const isTask = trimmed.length >= TASK_LENGTH

  const findings: Finding[] = []
  const missing = exists && references.length > 0 ? references.filter((reference) => !exists(reference)) : []

  if (missing.length > 0) {
    findings.push({
      level: "warn",
      code: "anchor-missing",
      message: `nicht gefunden: ${missing.slice(0, 2).join(", ")}`,
    })
  }

  if (anchor === "none" && isTask) {
    findings.push({ level: "info", code: "no-anchor", message: `kein Pfad genannt ${ANCHOR_HINT}` })
  }

  if (trimmed.length > 2000) {
    findings.push({ level: "info", code: "too-long", message: "über 2000 Zeichen — der Auftrag verliert an Kante" })
  }

  if (anchor !== "none" && isTask && !CRITERIA.test(trimmed)) {
    findings.push({ level: "info", code: "no-criteria", message: "nennt kein überprüfbares Ergebnis" })
  }

  return { text: trimmed, anchor, references, missing, findings }
}

export const worstLevel = (verdict: PromptVerdict): "warn" | "info" | undefined => {
  if (verdict.findings.some((f) => f.level === "warn")) return "warn"
  return verdict.findings.length > 0 ? "info" : undefined
}

/** Ein Satz für die Footerzeile. Nur der Kern, Details bleiben in der Story. */
export const verdictLine = (verdict: PromptVerdict): string | undefined => {
  const worst = verdict.findings.find((f) => f.level === "warn") ?? verdict.findings[0]
  return worst?.message
}
