import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useData } from "../context/data"
import { For, Match, Show, Switch, createMemo } from "solid-js"
import type { ResolvedTheme } from "@opencode/theme/tui"

export type StatusMcp = { name: string; status: { status: string; error?: string } }
export type StatusProvider = { id: string; activation: string }
export type StatusModel = { providerID: string }

export type StatusFixture = {
  mcp?: StatusMcp[]
  providers?: StatusProvider[]
  models?: StatusModel[]
}

/**
 * Reine Darstellung — keine Datenquelle. Dadurch lässt sich der Dialog ohne den
 * kompletten Provider-Stack rendern und einzeln prüfen.
 */
export function StatusBody(props: {
  theme: ResolvedTheme
  onClose: () => void
  mcp: StatusMcp[]
  providers: StatusProvider[]
  models: StatusModel[]
}) {
  const theme = props.theme
  const mcp = () => props.mcp
  const connected = createMemo(() => mcp().filter((item) => item.status.status === "connected").length)
  const broken = createMemo(
    () => mcp().filter((item) => item.status.status === "failed" || item.status.status === "needs_auth").length,
  )
  const usable = createMemo(() => props.providers.filter((item) => item.activation !== "disabled"))
  const providersInUse = createMemo(() => new Set(props.models.map((model) => model.providerID)).size)

  const color = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.base
    if (status === "failed") return theme.text.feedback.error.base
    if (status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.text.muted} onMouseUp={() => props.onClose()}>
          esc
        </text>
      </box>

      <Show when={mcp().length > 0} fallback={<text fg={theme.text.base}>No MCP servers</text>}>
        <box gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.base}>
              <b>MCP</b>
            </text>
            <text fg={broken() > 0 ? theme.text.feedback.warning.base : theme.text.muted}>
              {mcp().length} configured · {connected()} connected
              <Show when={broken() > 0}> · {broken()} need attention</Show>
            </text>
          </box>
          <For each={mcp()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: color(item.status.status) }}>
                  •
                </text>
                <text fg={theme.text.base} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.text.muted }}>
                    <Switch fallback={item.status.status}>
                      <Match when={item.status.status === "connected"}>Connected</Match>
                      <Match when={item.status.status === "failed" && item.status}>{(val) => val().error}</Match>
                      <Match when={item.status.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={item.status.status === "needs_auth" && item.status}>
                        {(val) => `Needs authentication: ${val().error}`}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      <box gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base}>
            <b>Providers</b>
          </text>
          <text fg={usable().length === 0 ? theme.text.feedback.error.base : theme.text.muted}>
            {usable().length} usable of {props.providers.length}
          </text>
        </box>
        <Show when={usable().length === 0}>
          <text fg={theme.text.muted} wrapMode="word">
            No provider is enabled, so no paid model can be selected. Run /connect to authenticate one.
          </text>
        </Show>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.text.base}>
          <b>Models</b>
        </text>
        <text fg={props.models.length === 0 ? theme.text.feedback.warning.base : theme.text.muted}>
          {props.models.length} available across {providersInUse()} providers
        </text>
      </box>
      <Show when={props.models.length === 0}>
        <text fg={theme.text.muted} wrapMode="word">
          The model catalogue is empty. It refreshes on start; if it stays empty, check network access to the provider
          registry.
        </text>
      </Show>
    </box>
  )
}

export function DialogStatus(props: { fixture?: StatusFixture } = {}) {
  const data = useData()
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const location = createMemo(() => data.location.default())

  return (
    <StatusBody
      theme={theme}
      onClose={() => dialog.clear()}
      mcp={props.fixture?.mcp ?? data.location.mcp.server.list(location()) ?? []}
      providers={props.fixture?.providers ?? data.location.provider.list(location()) ?? []}
      models={props.fixture?.models ?? data.location.model.list(location()) ?? []}
    />
  )
}
