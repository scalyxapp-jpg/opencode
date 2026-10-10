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
  const level: ContextLevel =
    usage.percent === undefined || usage.percent >= ERROR_PERCENT
      ? usage.percent === undefined
        ? "ok"
        : "error"
      : usage.percent >= WARNING_PERCENT
        ? "warning"
        : "ok"
  return {
    tokens: usage.tokens,
    percent: usage.percent,
    limit,
    remaining: limit === undefined ? undefined : Math.max(0, limit - usage.tokens),
    level,
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
