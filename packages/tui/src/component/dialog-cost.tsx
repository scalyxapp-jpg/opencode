import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo } from "solid-js"
import { useData } from "../context/data"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Locale, truncateWidth } from "../util/locale"
import { stringWidth } from "../util/string-width"
import { contextPressure, type ContextLevel } from "../util/session"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

export type CostBucket = {
  key: string
  turns: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type CostFixture = {
  title?: string
  buckets: CostBucket[]
  /** contextPressure()-Ergebnis; ohne Limit entfällt der Balken. */
  pressure?: { tokens: number; percent?: number; limit?: number; remaining?: number; level: ContextLevel }
  /** true, wenn keine Session offen ist — für die leere Ansicht. */
  noSession?: boolean
}

export type CostTotals = Omit<CostBucket, "key">

const zeroTotals = (): CostTotals => ({
  turns: 0,
  cost: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

export const sumBuckets = (buckets: readonly CostBucket[]): CostTotals =>
  buckets.reduce(
    (acc, bucket) => ({
      turns: acc.turns + bucket.turns,
      cost: acc.cost + bucket.cost,
      input: acc.input + bucket.input,
      output: acc.output + bucket.output,
      reasoning: acc.reasoning + bucket.reasoning,
      cacheRead: acc.cacheRead + bucket.cacheRead,
      cacheWrite: acc.cacheWrite + bucket.cacheWrite,
    }),
    zeroTotals(),
  )

export const cacheRatio = (totals: CostTotals): number => {
  const prompt = totals.cacheRead + totals.input
  return prompt > 0 ? totals.cacheRead / prompt : 0
}

type SurfaceTheme = ReturnType<ReturnType<typeof useTheme>["surface"]>

function Row(props: { theme: SurfaceTheme; cells: string[]; widths: number[]; muted?: boolean }) {
  return (
    <text fg={props.muted ? props.theme.text.muted : props.theme.text.base} wrapMode="none">
      {props.cells
        .map((cell, index) =>
          index === 0 ? cell.padEnd(props.widths[index] ?? 0) : cell.padStart(props.widths[index] ?? 0),
        )
        .join(" ")}
    </text>
  )
}

export function DialogCost(props: { fixture?: CostFixture } = {}) {
  const data = useData()
  const route = useRoute()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const session = createMemo(() => {
    const id = sessionID()
    return id ? data.session.get(id) : undefined
  })
  const messages = createMemo(() => {
    const id = sessionID()
    return id ? data.session.message.list(id) : []
  })

  const buckets = createMemo<CostBucket[]>(() => {
    if (props.fixture) return props.fixture.buckets
    const map = new Map<string, CostBucket>()
    for (const message of messages()) {
      if (message.type !== "assistant" || !message.tokens) continue
      const key = `${message.model.providerID}/${message.model.id}:${message.model.variant ?? "default"}`
      const bucket = map.get(key) ?? { key, ...zeroTotals() }
      bucket.turns += 1
      bucket.cost += message.cost ?? 0
      bucket.input += message.tokens.input
      bucket.output += message.tokens.output
      bucket.reasoning += message.tokens.reasoning
      bucket.cacheRead += message.tokens.cache.read
      bucket.cacheWrite += message.tokens.cache.write
      map.set(key, bucket)
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost || b.cacheRead - a.cacheRead)
  })

  const totals = createMemo(() => sumBuckets(buckets()))
  const ratio = createMemo(() => cacheRatio(totals()))

  const pressure = createMemo(() => {
    if (props.fixture) return props.fixture.pressure
    const current = session()
    if (!current) return
    return contextPressure(messages(), data.location.model.list(current.location), current.revert?.messageID)
  })

  const title = createMemo(() => props.fixture?.title ?? session()?.title)
  const noSession = createMemo(() => (props.fixture ? (props.fixture.noSession ?? false) : !sessionID()))

  const widths = createMemo(() => {
    const narrow = dimensions().width < 88
    const fixed = narrow ? [5, 7, 8, 7, 7, 7] : [6, 9, 9, 8, 8, 8]
    const sum = fixed.reduce((a, b) => a + b, 0)
    const budget = Math.max(10, dimensions().width - 4 - fixed.length - sum)
    const longest = buckets().reduce((max, bucket) => Math.max(max, stringWidth(bucket.key)), 6)
    return [Math.max(narrow ? 6 : 8, Math.min(narrow ? 24 : 34, budget, longest)), ...fixed]
  })

  const bar = createMemo(() => {
    const current = pressure()
    if (!current?.limit || current.percent === undefined) return undefined
    const readOut = `${Locale.number(current.tokens)}/${Locale.number(current.limit)} · ${Locale.number(current.remaining ?? 0)} free`
    const label = "Context "
    // Balken bekommt nur, was nach Label, Leerraum und Kennzahlen übrig bleibt.
    const available = dimensions().width - 4 - stringWidth(label) - stringWidth(readOut) - 2
    if (available < 8) return undefined
    const width = Math.min(48, available)
    const filled = Math.round((Math.min(100, current.percent) / 100) * width)
    const tone =
      current.level === "error"
        ? theme.text.feedback.error.base
        : current.level === "warning"
          ? theme.text.feedback.warning.base
          : theme.text.feedback.success.base
    return { tone, readOut, text: "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled)) }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Session cost
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show when={noSession()}>
        <text fg={theme.text.base}>Open a session first.</text>
      </Show>

      <Show when={buckets().length > 0}>
        <box flexDirection="column">
          <Row
            theme={theme}
            muted
            widths={widths()}
            cells={["MODEL", "TURNS", "INPUT", "OUTPUT", "THINK", "CACHE", "COST"]}
          />
          <For each={buckets()}>
            {(bucket) => (
              <Row
                theme={theme}
                widths={widths()}
                cells={[
                  truncateWidth(bucket.key, widths()[0] ?? 34),
                  String(bucket.turns),
                  Locale.number(bucket.input),
                  Locale.number(bucket.output),
                  Locale.number(bucket.reasoning),
                  Locale.number(bucket.cacheRead),
                  money.format(bucket.cost),
                ]}
              />
            )}
          </For>
        </box>

        <Row
          theme={theme}
          widths={widths()}
          cells={[
            "Total",
            String(totals().turns),
            Locale.number(totals().input),
            Locale.number(totals().output),
            Locale.number(totals().reasoning),
            Locale.number(totals().cacheRead),
            money.format(totals().cost),
          ]}
        />

        <box flexDirection="row" gap={1}>
          <text fg={theme.text.muted}>Cache</text>
          <text
            fg={
              ratio() >= 0.5
                ? theme.text.feedback.success.base
                : ratio() >= 0.2
                  ? theme.text.base
                  : theme.text.feedback.warning.base
            }
          >
            {(ratio() * 100).toFixed(1)}% of prompt volume reused
          </text>
        </box>

        <Show when={totals().cacheWrite > 0}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.muted}>Cache write</text>
            <text fg={theme.text.base}>{Locale.number(totals().cacheWrite)}</text>
          </box>
        </Show>

        <Show when={bar()}>
          {(currentBar) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.text.muted}>Context</text>
              <text fg={currentBar().tone}>{currentBar().text}</text>
              <text fg={theme.text.base}>{currentBar().readOut}</text>
            </box>
          )}
        </Show>

        <Show when={stringWidth(title() ?? "") > 0}>
          <text fg={theme.text.muted} wrapMode="word">
            {truncateWidth(title() ?? "", Math.max(20, dimensions().width - 6))}
          </text>
        </Show>
      </Show>

      <Show when={buckets().length === 0 && !noSession()}>
        <text fg={theme.text.base}>No usage recorded yet.</text>
      </Show>
    </box>
  )
}
