/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { ContextPulse } from "../../src/component/context-pulse"
import type { ContextSample } from "../../src/util/session"

const LIMIT = 1_048_576

const sample = (tokens: number, compacted = false): ContextSample => {
  const percent = Math.round((tokens / LIMIT) * 100)
  return {
    tokens,
    percent,
    level: percent >= 90 ? "error" : percent >= 70 ? "warning" : "ok",
    compacted,
    cost: 0.02,
    model: "deepseek/deepseek-v4-flash",
  }
}

const context = () =>
  ({
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
  }) as unknown as Context

const render = async (samples: ContextSample[]) => {
  const app = await testRender(() => <ContextPulse context={context()} sessionID="fixture" fixture={samples} />, {
    width: 42,
    height: 8,
  })
  await app.renderOnce()
  return app
}

test("context pulse renders one bar per turn", async () => {
  const app = await render([sample(100_000), sample(200_000), sample(300_000)])
  try {
    const frame = app.captureCharFrame()
    // Die Balken skalieren gegen den Spitzenwert der Session, nicht absolut —
    // sonst wäre ein kurzer Verlauf unsichtbar flach.
    expect(frame).toContain("▃▆█")
    expect(frame).toContain("3 turns")
    expect(frame).toContain("300.0K · 29%")
  } finally {
    app.renderer.destroy()
  }
})

test("context pulse hides itself without usage", async () => {
  const app = await render([])
  try {
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("context pulse marks a compaction and keeps the turn count visible", async () => {
  const app = await render([sample(100_000), sample(900_000, true), sample(120_000)])
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("1 compaction")
    expect(frame).toContain("3 turns")
  } finally {
    app.renderer.destroy()
  }
})

test("context pulse colours each bar by its own pressure level", async () => {
  const app = await render([sample(200_000), sample(LIMIT * 0.75), sample(LIMIT * 0.95)])
  try {
    const texts: TextRenderable[] = []
    const collect = (node: { getChildren?: () => unknown[] }) => {
      if (node instanceof TextRenderable) texts.push(node)
      for (const child of node.getChildren?.() ?? []) collect(child as { getChildren?: () => unknown[] })
    }
    collect(app.renderer.root as unknown as { getChildren?: () => unknown[] })


    const spansOf = (node: unknown): { _fg?: { toInts(): number[] } }[] => {
      if (!node) return []
      const typed = node as { constructor?: { name?: string }; children?: unknown[] }
      const self = String(typed.constructor?.name ?? "").includes("Span") ? [typed as never] : []
      return [...self, ...(typed.children ?? []).flatMap(spansOf)]
    }

    // Die Überschrift trägt einen Bold-Span; gesucht ist der Knoten mit den
    // meisten Spans, also die Balken-Zeile.
    const bars = texts
      .map((node) => spansOf((node as unknown as { rootTextNode?: unknown }).rootTextNode))
      .sort((a, b) => b.length - a.length)[0]!
    expect(bars).toHaveLength(3)
    expect(bars[0]?._fg?.toInts()).toEqual(RGBA.fromInts(80, 200, 120).toInts())
    expect(bars[1]?._fg?.toInts()).toEqual(RGBA.fromInts(220, 180, 60).toInts())
    expect(bars[2]?._fg?.toInts()).toEqual(RGBA.fromInts(230, 80, 80).toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("context pulse shows only the most recent turns in a narrow sidebar", async () => {
  const many = Array.from({ length: 60 }, (_, i) => sample(50_000 + i * 5_000))
  const app = await render(many)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("60 turns")
    // 60 Balken passen nicht in 42 Spalten; der Verlauf wird beschnitten.
    const bars = (frame.match(/[▁-█]/g) ?? []).length
    expect(bars).toBeLessThanOrEqual(38)
    expect(bars).toBeGreaterThan(20)
  } finally {
    app.renderer.destroy()
  }
})
