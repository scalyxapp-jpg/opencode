/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { StatusBody, type StatusFixture } from "../../src/component/dialog-status"
import type { ResolvedTheme } from "@opencode/theme/tui"

const theme = () =>
  ({
    text: {
      base: RGBA.fromInts(200, 200, 200),
      muted: RGBA.fromInts(100, 100, 100),
      feedback: {
        success: { base: RGBA.fromInts(80, 200, 120) },
        warning: { base: RGBA.fromInts(220, 180, 60) },
        error: { base: RGBA.fromInts(230, 80, 80) },
      },
    },
  }) as unknown as ResolvedTheme

const show = async (options: StatusFixture) => {
  const app = await testRender(
    () => (
      <StatusBody
        theme={theme()}
        onClose={() => {}}
        mcp={options.mcp ?? []}
        providers={options.providers ?? []}
        models={options.models ?? []}
      />
    ),
    { width: 80, height: 24 },
  )
  await app.renderOnce()
  const frame = app
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
  app.renderer.destroy()
  return frame
}

test("status summarises MCP servers instead of only listing them", async () => {
  const frame = await show({
    mcp: [
      { name: "alpha", status: { status: "connected" } },
      { name: "beta", status: { status: "connected" } },
      { name: "gamma", status: { status: "failed", error: "spawn ENOENT" } },
    ],
  })
  expect(frame).toContain("3 configured · 2 connected · 1 need attention")
  expect(frame).toContain("gamma")
  expect(frame).toContain("spawn ENOENT")
})

test("status stays quiet about problems when everything is healthy", async () => {
  const frame = await show({ mcp: [{ name: "alpha", status: { status: "connected" } }] })
  expect(frame).toContain("1 configured · 1 connected")
  expect(frame).not.toContain("need attention")
})

test("status counts usable providers separately from disabled ones", async () => {
  const frame = await show({
    providers: [
      { id: "deepseek", activation: "enabled" },
      { id: "opencode", activation: "auto" },
      { id: "legacy", activation: "disabled" },
    ],
  })
  expect(frame).toContain("2 usable of 3")
  expect(frame).not.toContain("No provider is enabled")
})

test("status warns when no provider is usable at all", async () => {
  const frame = await show({ providers: [{ id: "deepseek", activation: "disabled" }] })
  expect(frame).toContain("0 usable of 1")
  expect(frame).toContain("No provider is enabled")
})

test("status reports the model catalogue size and provider spread", async () => {
  const frame = await show({
    models: [{ providerID: "deepseek" }, { providerID: "deepseek" }, { providerID: "openai" }],
  })
  expect(frame).toContain("3 available across 2 providers")
  expect(frame).not.toContain("catalogue is empty")
})

test("status explains an empty model catalogue", async () => {
  const frame = await show({ models: [] })
  expect(frame).toContain("0 available across 0 providers")
  expect(frame).toContain("catalogue is empty")
})
