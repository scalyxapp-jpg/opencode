/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { Dialog } from "@opencode/plugin/tui/context"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { createDialogApi } from "../../src/plugin/api"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { parseSuggestions, toOptions, type Suggestion } from "../../src/util/suggest"

/**
 * Die Modellantwort aus einem echten Lauf dieser Installation. Sie belegt, dass
 * der Parser mit dem Format zurechtkommt, das das Modell tatsächlich liefert,
 * und dass die daraus gebauten Optionen im echten Auswahl-Dialog erscheinen.
 */
const REAL_RESPONSE = JSON.stringify([
  {
    title: "TUI-Features an einer echten Session prüfen",
    detail: "Alle Features sind bisher nur über Storybook und Tests belegt.",
  },
  {
    title: "MCP-Kontextbudget sichtbar machen",
    detail: "Neun Server mit 106 Tool-Definitionen kosten bei jedem Request Kontext.",
  },
  { title: "Vorbestehende Timeouts beheben", detail: "Sie verdecken echte Regressionen." },
])

async function mount(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const dialog = Promise.withResolvers<Dialog>()

  function Fixture() {
    dialog.resolve(createDialogApi(useDialog(), (render) => render()))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, dialog: await dialog.promise }
}

test("suggestions from a real model response appear as selectable options", async () => {
  await using tmp = await tmpdir()
  const { app, dialog } = await mount(tmp.path)
  try {
    const parsed = parseSuggestions(REAL_RESPONSE)
    expect(parsed.shape).toBe("json")

    const chosen = dialog.select<Suggestion>({
      title: "Was als Nächstes?",
      placeholder: "Vorschlag filtern",
      options: toOptions(parsed.suggestions),
    })

    await app.waitForFrame((frame) => frame.includes("Was als Nächstes?"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

    const frame = app.captureCharFrame()
    expect(frame).toContain("TUI-Features an einer echten Session prüfen")
    expect(frame).toContain("MCP-Kontextbudget sichtbar machen")
    expect(frame).toContain("Vorbestehende Timeouts beheben")
    expect(frame).toContain("Vorschlag")

    app.mockInput.pressEnter()
    const picked = await chosen
    expect(picked?.title).toBe("TUI-Features an einer echten Session prüfen")
    expect(picked?.detail).toContain("Storybook")
  } finally {
    app.renderer.destroy()
  }
})

test("filtering narrows the suggestions", async () => {
  await using tmp = await tmpdir()
  const { app, dialog } = await mount(tmp.path)
  try {
    const parsed = parseSuggestions(REAL_RESPONSE)
    const chosen = dialog.select<Suggestion>({
      title: "Was als Nächstes?",
      options: toOptions(parsed.suggestions),
    })
    await app.waitForFrame((frame) => frame.includes("Was als Nächstes?"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

    await app.mockInput.typeText("mcp")
    await app.waitForFrame((frame) => !frame.includes("Vorbestehende Timeouts"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("MCP-Kontextbudget sichtbar machen")
    expect(frame).not.toContain("TUI-Features an einer echten Session prüfen")

    app.mockInput.pressEnter()
    expect((await chosen)?.title).toBe("MCP-Kontextbudget sichtbar machen")
  } finally {
    app.renderer.destroy()
  }
})
