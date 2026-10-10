import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { contextPressure, formatContextPressure } from "../../src/util/session"

const LIMIT = 1_048_576

const model = (limit: number | undefined): ModelInfo =>
  ({ providerID: "deepseek", id: "deepseek-v4-flash", limit: { context: limit } }) as unknown as ModelInfo

const assistant = (
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  id = "msg_1",
): SessionMessageInfo =>
  ({
    id,
    type: "assistant",
    model: { providerID: "deepseek", id: "deepseek-v4-flash" },
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.read, write: tokens.write },
    },
  }) as unknown as SessionMessageInfo

const at = (tokens: number) => assistant({ input: tokens, output: 0, reasoning: 0, read: 0, write: 0 })

describe("contextPressure", () => {
  test("summiert alle Token-Buckets", () => {
    const pressure = contextPressure(
      [assistant({ input: 100, output: 200, reasoning: 300, read: 400, write: 500 })],
      [model(LIMIT)],
    )
    expect(pressure?.tokens).toBe(1500)
  })

  test("stufe ok unterhalb der Warnschwelle", () => {
    expect(contextPressure([at(600_000)], [model(LIMIT)])?.level).toBe("ok")
  })

  test("stufe warning ab 70 Prozent", () => {
    expect(contextPressure([at(734_003)], [model(LIMIT)])?.level).toBe("warning")
  })

  test("stufe error ab 90 Prozent", () => {
    expect(contextPressure([at(950_000)], [model(LIMIT)])?.level).toBe("error")
  })

  test("bleibt ok, wenn das Modell kein Context-Limit kennt", () => {
    const pressure = contextPressure([at(9_000_000)], [model(undefined)])
    expect(pressure?.percent).toBeUndefined()
    expect(pressure?.remaining).toBeUndefined()
    expect(pressure?.level).toBe("ok")
  })

  test("ohne Usage-Message kommt nichts zurück", () => {
    expect(contextPressure([], [model(LIMIT)])).toBeUndefined()
  })

  test("ignoriert Messages vor der letzten Kompaktierung", () => {
    const compaction = {
      id: "msg_2",
      type: "compaction",
      status: "completed",
    } as unknown as SessionMessageInfo
    expect(contextPressure([at(500_000), compaction, at(1000)], [model(LIMIT)])?.tokens).toBe(1000)
  })

  test("respektiert eine Revert-Grenze", () => {
    const before = at(500_000)
    const after = at(1000)
    // Revert auf msg_2 heißt: alles NACH msg_2 verwerfen, also bleibt msg_1.
    const messages = [before, { ...after, id: "msg_2" } as SessionMessageInfo]
    expect(contextPressure(messages, [model(LIMIT)], "msg_2")?.tokens).toBe(500_000)
  })

  test("unbekannte Revert-Grenze liefert nichts", () => {
    expect(contextPressure([at(500_000)], [model(LIMIT)], "msg_gibt_es_nicht")).toBeUndefined()
  })
})

describe("formatContextPressure", () => {
  test("ohne Druck bleibt die Zeile kurz wie bisher", () => {
    expect(formatContextPressure(contextPressure([at(1_000)], [model(10_000)])!)).toBe("1.0K (10%)")
  })

  test("ab der Warnstufe kommt das Restbudget dazu", () => {
    expect(formatContextPressure(contextPressure([at(734_003)], [model(LIMIT)])!)).toBe("70% · 314.6K free")
  })

  test("Fehlerstufe nennt nur Prozent und Rest", () => {
    expect(formatContextPressure(contextPressure([at(975_171)], [model(LIMIT)])!)).toBe("93% · 73.4K free")
  })

  test("ohne Limit: nur Tokenzahl, egal welche Stufe", () => {
    expect(formatContextPressure(contextPressure([at(1234)], [model(undefined)])!)).toBe("1.2K")
  })

  test("Rest ist nie negativ", () => {
    const pressure = contextPressure([at(LIMIT + 5000)], [model(LIMIT)])!
    expect(pressure.remaining).toBe(0)
    expect(formatContextPressure(pressure)).toContain("0 free")
  })

  test("beide Formen passen in das Footer-Budget", () => {
    // promptFooterLayout gibt bei Breite 80 genau 44 Zeichen für
    // usage + " · " + shortcuts frei. Beide Stufen müssen hineinpassen,
    // sonst verschwindet der Kürzel-Hinweis bei Breite 80.
    const budget = 44
    const withShortcuts = (usage: string) => usage.length + " · ctrl+p commands".length

    const calm = formatContextPressure(contextPressure([at(1_000)], [model(10_000)])!)
    expect(withShortcuts(`${calm} · $1.00`)).toBeLessThanOrEqual(budget)

    const urgent = formatContextPressure(contextPressure([at(734_003)], [model(LIMIT)])!)
    expect(withShortcuts(`${urgent} · $1.00`)).toBeLessThanOrEqual(budget)
    expect(urgent).toBe("70% · 314.6K free")
  })
})
