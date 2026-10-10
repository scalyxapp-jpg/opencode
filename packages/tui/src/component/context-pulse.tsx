import { For, Show, createMemo } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { Locale } from "../util/locale"
import { contextTimeline, type ContextLevel, type ContextSample } from "../util/session"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** Acht Höhen, damit der Verlauf auch ohne Farbe ablesbar bleibt. */
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

const tone = (theme: Plugin.Context["theme"], level: ContextLevel) => {
  if (level === "error") return theme.text.feedback.error.base
  if (level === "warning") return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

/**
 * Sparkline des Kontextverlaufs einer Session, ältester Turn links.
 *
 * Ohne Fixture liest die Komponente die Live-Daten des Contexts; mit Fixture
 * rendert die Storybook-Story dieselbe Komponente.
 */
export function ContextPulse(props: { context: Plugin.Context; sessionID: string; fixture?: ContextSample[] }) {
  const theme = props.context.theme

  const samples = createMemo<ContextSample[]>(() => {
    if (props.fixture) return props.fixture
    const session = props.context.data.session.get(props.sessionID)
    if (!session) return []
    return contextTimeline(
      props.context.data.session.message.list(props.sessionID),
      props.context.data.location.model.list(session.location),
      session.revert?.messageID,
    )
  })

  // Die Sidebar ist 42 Spalten breit, davon bleiben nach Einrückung ~34.
  const visible = createMemo(() => samples().slice(-Math.max(6, 34)))

  const scaled = createMemo(() => {
    const all = samples()
    if (all.length === 0) return []
    const peak = all.reduce((max, sample) => Math.max(max, sample.tokens), 0)
    return visible().map((sample) => ({
      sample,
      glyph: BARS[Math.min(BARS.length - 1, Math.floor((sample.tokens / peak) * BARS.length))] ?? BARS[0],
    }))
  })

  const latest = createMemo(() => samples().at(-1))
  const compacted = createMemo(() => samples().filter((sample) => sample.compacted).length)
  const total = createMemo(() => samples().reduce((sum, sample) => sum + sample.cost, 0))

  const footer = createMemo(() => {
    const sample = latest()
    if (!sample) return undefined
    const parts = [Locale.number(sample.tokens)]
    if (sample.percent !== undefined) parts.push(`${sample.percent}%`)
    if (total() > 0) parts.push(money.format(total()))
    return parts.join(" · ")
  })

  return (
    <Show when={samples().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Context</b>
        </text>

        <text fg={theme.text.muted} wrapMode="none">
          {scaled().length > 0 ? (
            <For each={scaled()}>
              {(entry) => <span style={{ fg: tone(theme, entry.sample.level) }}>{entry.glyph}</span>}
            </For>
          ) : (
            ""
          )}
        </text>

        <Show when={footer()}>
          {(value) => (
            <text fg={latest()?.level === "error" ? theme.text.feedback.error.base : theme.text.muted}>{value()}</text>
          )}
        </Show>

        <text fg={theme.text.muted}>
          {samples().length} turn{samples().length === 1 ? "" : "s"}
          <Show when={compacted() > 0}>
            {" "}
            · {compacted()} compaction{compacted() === 1 ? "" : "s"}
          </Show>
        </text>
      </box>
    </Show>
  )
}
