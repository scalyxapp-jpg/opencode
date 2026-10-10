import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { ContextPulse } from "../../../component/context-pulse"
import { useTheme } from "../../../context/theme"
import type { ContextSample } from "../../../util/session"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const LIMIT = 1_048_576

const sample = (tokens: number, opts: { compacted?: boolean; cost?: number } = {}): ContextSample => {
  const percent = Math.round((tokens / LIMIT) * 100)
  return {
    tokens,
    percent,
    level: percent >= 90 ? "error" : percent >= 70 ? "warning" : "ok",
    compacted: opts.compacted ?? false,
    cost: opts.cost ?? 0.01,
    model: "deepseek/deepseek-v4-flash",
  }
}

/** Vier charakteristische Verläufe: sanft, kompaktiert, kriechend, frisch. */
const cases: { id: string; label: string; samples: ContextSample[] }[] = [
  {
    id: "smooth",
    label: "steady growth",
    samples: [120_000, 145_000, 168_000, 192_000, 214_000, 238_000, 262_000, 281_000].map((t) => sample(t)),
  },
  {
    id: "compacted",
    label: "compaction cliff",
    samples: [
      ...[180_000, 320_000, 510_000, 700_000, 880_000].map((t) => sample(t)),
      sample(96_000, { compacted: true, cost: 0.06 }),
      ...[140_000, 190_000, 245_000, 300_000].map((t) => sample(t)),
    ],
  },
  {
    id: "creeping",
    label: "context creeping",
    samples: [640_000, 700_000, 735_000, 790_000, 862_000, 918_000, 974_000, 1_031_000, 1_048_576].map((t) =>
      sample(t, { cost: 0.09 }),
    ),
  },
  {
    id: "fresh",
    label: "just started",
    samples: [48_000, 92_000].map((t) => sample(t, { cost: 0.02 })),
  },
]

function ContextPulseStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
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

  const peak = createMemo(() => current().samples.reduce((max, s) => Math.max(max, s.tokens), 0))

  return (
    <box flexDirection="column" width={dimensions().width} height={dimensions().height} paddingLeft={2} paddingTop={1}>
      <text fg={theme.text.base}>
        <b>Sidebar / Context pulse</b>
      </text>
      <text fg={theme.text.muted}>Rendered inside the 42-column sidebar.</text>

      <box height={1} />
      <box
        width={42}
        backgroundColor={theme.background.raised.base}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <ContextPulse context={props.context} sessionID="fixture" fixture={current().samples} />
      </box>

      <box flexGrow={1} />
      <StoryFooter
        context={props.context}
        title="storybook / context pulse"
        details={[current().label]}
        status={`${current().samples.length} turns · peak ${Math.round(peak() / 1000)}K tokens`}
        controls={[
          { shortcut: "←→", label: "case" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const contextPulseStory: Story = {
  id: "context-pulse",
  title: "Context pulse",
  render: (context) => <ContextPulseStory context={context} />,
}
