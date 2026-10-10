/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import type { Context } from "@opencode/plugin/tui/context"
import { ContextPulse } from "../../src/component/context-pulse"

const LIMIT = 1_048_576

const turn = (index: number) => ({
  id: `m${index}`,
  type: "assistant" as const,
  model: { providerID: "deepseek", id: "deepseek-v4-flash" },
  tokens: { input: 40_000 + index * 900, output: 2_000, reasoning: 1_500, cache: { read: 300_000, write: 0 } },
  cost: 0.03,
})

const setup = (count: number) => {
  const [store, setStore] = createStore({ msgs: Array.from({ length: count }, (_, index) => turn(index)) })
  const context = {
    theme: {
      text: {
        base: RGBA.fromInts(200, 200, 200),
        muted: RGBA.fromInts(100, 100, 100),
        feedback: {
          success: { base: RGBA.fromInts(80, 200, 120) },
          warning: { base: RGBA.fromInts(220, 180, 60) },
          error: { base: RGBA.fromInts(230, 80, 80) },
        },
      },
    },
    data: {
      session: { get: () => ({ location: { directory: "/w" } }), message: { list: () => store.msgs } },
      location: {
        model: { list: () => [{ providerID: "deepseek", id: "deepseek-v4-flash", limit: { context: LIMIT } }] },
      },
    },
  } as unknown as Context
  return {
    context,
    append: (index: number) =>
      setStore(
        "msgs",
        produce((draft: ReturnType<typeof turn>[]) => draft.push(turn(index))),
      ),
  }
}

const rows = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

/** Streaming mutiert nur `content`; der Puls darf sich dadurch nicht neu zeichnen. */
test("context pulse ignores content-only streaming", async () => {
  const [store, setStore] = createStore({
    msgs: [
      {
        ...turn(0),
        content: [{ type: "text", text: "chunk-0" }],
      },
    ],
  })
  const context = {
    theme: {
      text: {
        base: RGBA.fromInts(200, 200, 200),
        muted: RGBA.fromInts(100, 100, 100),
        feedback: {
          success: { base: RGBA.fromInts(80, 200, 120) },
          warning: { base: RGBA.fromInts(220, 180, 60) },
          error: { base: RGBA.fromInts(230, 80, 80) },
        },
      },
    },
    data: {
      session: { get: () => ({ location: { directory: "/w" } }), message: { list: () => store.msgs } },
      location: {
        model: { list: () => [{ providerID: "deepseek", id: "deepseek-v4-flash", limit: { context: LIMIT } }] },
      },
    },
  } as unknown as Context

  const app = await testRender(() => <ContextPulse context={context} sessionID="s" />, { width: 42, height: 8 })

  try {
    await app.renderOnce()
    const before = app.captureCharFrame()
    for (let chunk = 1; chunk <= 5; chunk++) {
      setStore("msgs", 0, "content", [{ type: "text", text: `chunk-${chunk}` }] as never)
      await app.renderOnce()
    }
    // Der Puls liest Tokens und Kosten, nicht den laufenden Text — die Zeile bleibt stabil.
    expect(app.captureCharFrame()).toBe(before)
  } finally {
    app.renderer.destroy()
  }
})

/**
 * Der Puls muss live sein. Ein Feature, das nur mit Fixtures schön aussieht und
 * im echten Betrieb stehen bleibt, wäre wertlos — dieser Test fährt den echten
 * Reactive-Store und hängt einen Turn an.
 */
test("context pulse reacts to an appended turn", async () => {
  const { context, append } = setup(4)
  const app = await testRender(() => <ContextPulse context={context} sessionID="s" />, { width: 42, height: 8 })

  try {
    await app.renderOnce()
    const before = rows(app.captureCharFrame())
    expect(before[1]).toBe("\u2588".repeat(4))
    expect(before.some((row) => row === "4 turns")).toBe(true)

    append(4)
    await app.renderOnce()
    const after = rows(app.captureCharFrame())
    expect(after[1]).toBe("\u2588".repeat(5))
    expect(after.some((row) => row === "5 turns")).toBe(true)
    expect(after[2]).not.toBe(before[2])
  } finally {
    app.renderer.destroy()
  }
})

/**
 * Bremsschutz gegen den Rückfall in ein O(n)-Duplikat: die Timeline läuft bei
 * 35k Messages einmal durch und darf daran nicht scheitern.
 */
test("a 35k message session renders within budget", async () => {
  const { context } = setup(35_000)
  const app = await testRender(() => <ContextPulse context={context} sessionID="s" />, { width: 42, height: 8 })

  try {
    const started = performance.now()
    await app.renderOnce()
    const elapsed = performance.now() - started
    // Großzügige Schranke: sie greift nur bei einem Größenordnungs-Regress.
    expect(elapsed).toBeLessThan(400)
    expect(rows(app.captureCharFrame()).some((row) => row === "35000 turns")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
