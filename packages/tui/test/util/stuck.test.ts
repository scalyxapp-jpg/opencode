import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { stuckTool } from "../../src/util/stuck"

type ToolBlock = {
  name: string
  status: "error" | "completed"
  input: Record<string, unknown>
  message?: string
}

const assistant = (blocks: ToolBlock[]): SessionMessageInfo =>
  ({
    id: `msg_${blocks.map((b) => b.name + JSON.stringify(b.input)).join("|").length}`,
    type: "assistant",
    content: blocks.map((block, index) => ({
      type: "tool",
      id: `call_${index}_${Math.random()}`,
      name: block.name,
      state:
        block.status === "error"
          ? { status: "error", input: block.input, error: { type: "tool", message: block.message ?? "failed" } }
          : { status: "completed", input: block.input, output: "ok", title: block.name, metadata: {} },
    })),
  }) as unknown as SessionMessageInfo

const fail = (name: string, input: Record<string, unknown>, message?: string): ToolBlock => ({
  name,
  input,
  status: "error",
  ...(message ? { message } : {}),
})

const ok = (name: string, input: Record<string, unknown>): ToolBlock => ({ name, input, status: "completed" })

describe("stuckTool", () => {
  test("meldet drei identische Fehlschläge in Folge", () => {
    const input = { filePath: "/tmp/a.ts" }
    const report = stuckTool([assistant([fail("edit", input), fail("edit", input), fail("edit", input)])])
    expect(report?.tool).toBe("edit")
    expect(report?.attempts).toBe(3)
    expect(report?.target).toBe("/tmp/a.ts")
  })

  test("zwei Fehlschläge reichen nicht", () => {
    const input = { filePath: "/tmp/a.ts" }
    expect(stuckTool([assistant([fail("edit", input), fail("edit", input)])])).toBeUndefined()
  })

  test("ein Erfolg mit gleicher Eingabe widerlegt den Feststurz", () => {
    const input = { filePath: "/tmp/a.ts" }
    const report = stuckTool([
      assistant([fail("edit", input), fail("edit", input), ok("edit", input), fail("edit", input)]),
    ])
    expect(report).toBeUndefined()
  })

  test("die Reihenfolge der Parameter ist egal", () => {
    const report = stuckTool([
      assistant([fail("grep", { a: 1, b: 2 }), fail("grep", { b: 2, a: 1 }), fail("grep", { a: 1, b: 2 })]),
    ])
    expect(report?.attempts).toBe(3)
  })

  test("verschiedene Eingaben sind kein Feststurz", () => {
    const report = stuckTool([
      assistant([fail("read", { filePath: "/a" }), fail("read", { filePath: "/b" }), fail("read", { filePath: "/c" })]),
    ])
    expect(report).toBeUndefined()
  })

  test("verschiedene Tools mit gleicher Eingabe sind kein Feststurz", () => {
    const input = { filePath: "/a" }
    const report = stuckTool([assistant([fail("read", input), fail("edit", input), fail("bash", input)])])
    expect(report).toBeUndefined()
  })

  test("zählt über Message-Grenzen hinweg", () => {
    const input = { filePath: "/a" }
    const report = stuckTool([
      assistant([fail("edit", input)]),
      assistant([fail("edit", input)]),
      assistant([fail("edit", input)]),
    ])
    expect(report?.attempts).toBe(3)
  })

  test("nutzt die zuletzt gemeldete Fehlermeldung", () => {
    const input = { filePath: "/a" }
    const report = stuckTool([
      assistant([fail("edit", input, "first"), fail("edit", input, "second"), fail("edit", input, "third")]),
    ])
    expect(report?.error).toBe("third")
  })

  test("ignoriert Nicht-Tool-Content und andere Message-Typen", () => {
    const messages = [
      { id: "u", type: "user", text: "mach" },
      { id: "s", type: "system", text: "x" },
    ] as unknown as SessionMessageInfo[]
    expect(stuckTool(messages)).toBeUndefined()
  })

  test("leere Session ist unkritisch", () => {
    expect(stuckTool([])).toBeUndefined()
  })

  test("Schwelle ist konfigurierbar", () => {
    const input = { filePath: "/a" }
    const messages = [assistant([fail("edit", input), fail("edit", input)])]
    expect(stuckTool(messages)).toBeUndefined()
    expect(stuckTool(messages, 2)?.attempts).toBe(2)
  })

  test("große Eingaben werden nicht zum Speicherproblem", () => {
    const input = { content: "x".repeat(200_000) }
    const report = stuckTool([assistant([fail("write", input), fail("write", input), fail("write", input)])])
    expect(report?.attempts).toBe(3)
  })
})
