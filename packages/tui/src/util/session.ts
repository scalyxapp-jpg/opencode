import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { Locale } from "./locale"

type SessionNode = {
  id: string
  parentID?: string | null
}

export function sessionFamily<T extends SessionNode>(sessions: readonly T[], sessionID: string) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(sessionID)
  if (!current) return []

  const children = new Map<string, T[]>()
  sessions.forEach((session) => {
    if (!session.parentID) return
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  })

  function root(session: T): T {
    const parent = session.parentID ? byID.get(session.parentID) : undefined
    return parent ? root(parent) : session
  }

  function walk(parentID: string, ancestors: boolean[]): Array<{ session: T; prefix: string }> {
    const group = children.get(parentID) ?? []
    return group.flatMap((session, index) => {
      const last = index === group.length - 1
      const prefix =
        ancestors.length === 0
          ? ""
          : ancestors
              .slice(1)
              .map((ancestor) => (ancestor ? "   " : "│  "))
              .join("") + (last ? "└─ " : "├─ ")
      return [{ session, prefix }, ...walk(session.id, [...ancestors, last])]
    })
  }

  return walk(root(current).id, [])
}

export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

export function contextUsage(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  boundary?: string,
) {
  const last = lastAssistantWithUsage(messages, boundary)
  if (!last) return
  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return
  const model = models?.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)
  return {
    tokens,
    percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : undefined,
  }
}

export function formatContextUsage(tokens: number, percent?: number) {
  const value = Locale.number(tokens)
  return percent === undefined ? value : `${value} (${percent}%)`
}

export type ContextLevel = "ok" | "warning" | "error"

/**
 * Ab wie viel Kontextverbrauch die Anzeige warnen soll. Der Sprung auf `error`
 * liegt deutlich über `warning`, damit ein einzelner großer Turn nicht sofort
 * den roten Zustand auslöst.
 */
const WARNING_PERCENT = 70
const ERROR_PERCENT = 90

/**
 * Context usage plus Druckstufe. `remaining` ist die handlungsleitende Größe —
 * Prozent allein sagt nicht, wie viele Turns noch Platz haben.
 */
export function contextPressure(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  boundary?: string,
) {
  const usage = contextUsage(messages, models, boundary)
  if (!usage) return
  const last = lastAssistantWithUsage(messages, boundary)
  const model = last
    ? models?.find((item) => item.providerID === last.model.providerID && item.id === last.model.id)
    : undefined
  const limit = model?.limit.context
  return {
    tokens: usage.tokens,
    percent: usage.percent,
    limit,
    remaining: limit === undefined ? undefined : Math.max(0, limit - usage.tokens),
    level: levelFor(usage.percent),
  }
}

/**
 * Tokenformat für die Fußzeile. Solange kein Druck herrscht, bleibt die Zeile so
 * kurz wie vorher — das Platzbudget im Footer ist knapp und der Kürzel-Hinweis
 * darf nicht verdrängt werden. Erst ab der Warnstufe kommt das handlungsleitende
 * Restbudget dazu; die Warnfarbe trägt die Dringlichkeit.
 */
export function formatContextPressure(pressure: NonNullable<ReturnType<typeof contextPressure>>) {
  const tokens = Locale.number(pressure.tokens)
  const plain = pressure.percent === undefined ? tokens : `${tokens} (${pressure.percent}%)`
  if (pressure.level === "ok" || pressure.remaining === undefined) return plain
  return `${pressure.percent}% · ${Locale.number(pressure.remaining)} free`
}

export type ContextSample = {
  tokens: number
  percent?: number
  level: ContextLevel
  /** true direkt nach einer Kompaktierung — der Kontext ist dort abgesackt. */
  compacted: boolean
  cost: number
  model?: string
}

/**
 * Kontextverlauf über die Turns einer Session, älteste zuerst.
 *
 * Ein Wert pro Assistant-Message, der den Prompt-Umfang dieses Turns zeigt.
 * Weil die Werte nicht monoton wachsen, wird eine Kompaktierung als Sprung
 * sichtbar — genau das macht der Verlauf lesbar.
 */
export function contextTimeline(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  boundary?: string,
): ContextSample[] {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return []
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const samples: ContextSample[] = []
  let compacted = false

  for (const message of messages.slice(0, end)) {
    if (message.type === "compaction" && message.status === "completed") {
      compacted = true
      continue
    }
    if (message.type !== "assistant" || !message.tokens) continue

    const tokens =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
    if (tokens <= 0) continue

    const model = models?.find((item) => item.providerID === message.model.providerID && item.id === message.model.id)
    const percent = model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : undefined

    samples.push({
      tokens,
      percent,
      level: levelFor(percent),
      compacted,
      cost: message.cost ?? 0,
      model: `${message.model.providerID}/${message.model.id}`,
    })
    compacted = false
  }

  return samples
}

const levelFor = (percent: number | undefined): ContextLevel => {
  if (percent === undefined) return "ok"
  if (percent >= ERROR_PERCENT) return "error"
  if (percent >= WARNING_PERCENT) return "warning"
  return "ok"
}

export type ContextForecast = {
  /** Median des Wachstums pro Turn. */
  perTurn: number
  /** Verbleibende Turns bis zum Limit, undefined wenn kein Limit bekannt. */
  turnsLeft: number | undefined
  confidence: "low" | "medium" | "high"
  /** Anzahl der Turns, aus denen extrapoliert wurde. */
  window: number
}

/**
 * Prognose, wann der Kontext das Limit erreicht — aus der Wachstumsrate der
 * letzten Turns.
 *
 * Verwendet den Median statt des Mittelwerts: ein einzelner Riesenturn (großer
 * eingefügter Block) soll die Prognose nicht verzerren. Sobald im Fenster eine
 * Kompaktierung lag, ist die Rate nicht mehr extrapolierbar und die Zuversicht
 * sinkt auf "low" — dann zeigt die UI die Prognose gar nicht erst an.
 */
export function forecastContext(
  samples: ReadonlyArray<ContextSample>,
  limit: number | undefined,
  window = 6,
): ContextForecast | undefined {
  if (samples.length < 3) return
  const recent = samples.slice(-window)
  const deltas: number[] = []
  for (let i = 1; i < recent.length; i++) {
    deltas.push(recent[i]!.tokens - recent[i - 1]!.tokens)
  }
  if (deltas.length === 0) return

  const sorted = [...deltas].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!

  const compacted = recent.slice(1).some((sample) => sample.compacted)
  const current = samples.at(-1)!.tokens
  const headroom = limit === undefined ? undefined : limit - current

  // Wachstum <= 0 heißt: der Verlauf fällt oder steht. Dann gibt es nichts zu
  // prognostizieren — "unendlich Turns" wäre eine Augenauswischerei.
  if (median <= 0) {
    return { perTurn: median, turnsLeft: undefined, confidence: "low", window: deltas.length }
  }

  return {
    perTurn: median,
    turnsLeft: headroom === undefined ? undefined : headroom <= 0 ? 0 : Math.floor(headroom / median),
    confidence: compacted ? "low" : deltas.length >= 4 ? "high" : "medium",
    window: deltas.length,
  }
}
