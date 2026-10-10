/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarContext } from "../../src/feature-plugins/sidebar/context"

function context(options?: { cost?: number; tokens?: number }) {
  const color = RGBA.fromInts(200, 200, 200)
  const success = RGBA.fromInts(80, 200, 120)
  const warning = RGBA.fromInts(220, 180, 60)
  const error = RGBA.fromInts(230, 80, 80)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: {
          success: { base: success },
          warning: { base: warning },
          error: { base: error },
        },
      },
    },
    data: {
      session: {
        get: () => ({ location: { directory: "/workspace" } }),
        cost: () => options?.cost ?? 0,
        message: {
          list: () =>
            options?.tokens
              ? [
                  {
                    id: "message",
                    type: "assistant",
                    model: { providerID: "provider", id: "model" },
                    tokens: {
                      input: options.tokens,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                ]
              : [],
        },
      },
      location: {
        model: { list: () => [] },
      },
    },
  } as unknown as Context
}

test("sidebar omits context before usage is available", async () => {
  const app = await testRender(() => <SidebarContext context={context()} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Context")
    expect(app.captureCharFrame()).not.toContain("Not measured")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows available context usage", async () => {
  const app = await testRender(() => <SidebarContext context={context({ tokens: 1234 })} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Context")
    // Ohne Modell-Limit bleibt es bei der Tokenzahl, aber als Pulszeile.
    expect(frame).toMatch(/[\u2581-\u2588]/)
    expect(frame).toContain("1.2K")
    expect(frame).toContain("1 turn")
  } finally {
    app.renderer.destroy()
  }
})
