import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { DialogCost, type CostFixture } from "../../../component/dialog-cost"
import { contextPressure, formatContextPressure } from "../../../util/session"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

/**
 * Fixtures decken die drei Druckstufen ab. Die Werte stammen aus einer echten
 * DeepSeek-Session, damit Format und Spaltenbreiten realistisch bleiben.
 */
const LIMIT = 1048576

const cases: { id: string; label: string; fixture: CostFixture }[] = [
  {
    id: "healthy",
    label: "low pressure",
    fixture: {
      title: "Add an OCR pass over the archive",
      buckets: [
        {
          key: "deepseek/deepseek-flash:low",
          turns: 8,
          cost: 0.42,
          input: 1_240_000,
          output: 310_000,
          reasoning: 480_000,
          cacheRead: 9_100_000,
          cacheWrite: 0,
        },
        {
          key: "deepseek/deepseek-v4-pro:high",
          turns: 2,
          cost: 1.18,
          input: 420_000,
          output: 96_000,
          reasoning: 310_000,
          cacheRead: 2_400_000,
          cacheWrite: 0,
        },
      ],
      pressure: { tokens: 168_400, percent: 16, limit: LIMIT, remaining: LIMIT - 168_400, level: "ok" },
    },
  },
  {
    id: "warning",
    label: "70% context",
    fixture: {
      title: "Audit the auth middleware end to end",
      buckets: [
        {
          key: "deepseek/deepseek-v4-flash:low",
          turns: 17,
          cost: 3.9,
          input: 7_100_000,
          output: 1_400_000,
          reasoning: 1_900_000,
          cacheRead: 31_000_000,
          cacheWrite: 120_000,
        },
      ],
      pressure: { tokens: 734_003, percent: 70, limit: LIMIT, remaining: LIMIT - 734_003, level: "warning" },
    },
  },
  {
    id: "critical",
    label: "93% context",
    fixture: {
      title: "Migrate the session store to the v2 schema",
      buckets: [
        {
          key: "deepseek/deepseek-v4-pro:high",
          turns: 24,
          cost: 8.64,
          input: 18_900_000,
          output: 2_800_000,
          reasoning: 5_400_000,
          cacheRead: 96_000_000,
          cacheWrite: 1_400_000,
        },
        {
          key: "deepseek/deepseek-flash:low",
          turns: 11,
          cost: 1.02,
          input: 2_800_000,
          output: 480_000,
          reasoning: 620_000,
          cacheRead: 12_000_000,
          cacheWrite: 0,
        },
      ],
      pressure: { tokens: 975_171, percent: 93, limit: LIMIT, remaining: LIMIT - 975_171, level: "error" },
    },
  },
  {
    id: "empty",
    label: "no usage yet",
    fixture: { buckets: [], noSession: false },
  },
]

function SessionCostStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)
  const current = () => cases[selected()]!

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "right,l,space",
        title: "Next case",
        group: "Storybook",
        run: () => setSelected((value) => (value + 1) % cases.length),
      },
      {
        bind: "left,h",
        title: "Previous case",
        group: "Storybook",
        run: () => setSelected((value) => (value + cases.length - 1) % cases.length),
      },
    ],
  }))

  const pressure = createMemo(() => current().fixture.pressure)
  const footerLabel = createMemo(() => {
    const value = pressure()
    if (!value) return "—"
    return formatContextPressure({
      tokens: value.tokens,
      percent: value.percent,
      level: value.level,
      limit: value.limit,
      remaining: value.remaining,
    })
  })

  return (
    <box flexDirection="column" width={dimensions().width} height={dimensions().height}>
      <DialogCost fixture={current().fixture} />
      <box flexGrow={1} />
      <StoryFooter
        context={props.context}
        title="storybook / session cost"
        details={[current().label]}
        status={`footer would read: ${footerLabel()}`}
        controls={[
          { shortcut: "←→", label: "case" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const sessionCostStory: Story = {
  id: "session-cost",
  title: "Session cost",
  render: (context) => <SessionCostStory context={context} />,
}

export { cases as sessionCostCases }
export type { CostFixture }
export { contextPressure }
