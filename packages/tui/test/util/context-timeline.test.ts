import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { contextTimeline } from "../../src/util/session"

const LIMIT = 1_048_576

const model = { providerID: "deepseek", id: "deepseek-v4-flash", limit: { context: LIMIT } } as unknown as ModelInfo

const turn = (input: number, cost = 0.01, id = "msg"): SessionMessageInfo =>
  ({
    id,
    type: "assistant",
    model: { providerID: "deepseek", id: "deepseek-v4-flash" },
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost,
  }) as unknown as SessionMessageInfo

const compaction = (id = "cmp"): SessionMessageInfo =>
  ({ id, type: "compaction", status: "completed" }) as unknown as SessionMessageInfo

describe("contextTimeline", () => {
  test("liefert pro Assistant-Message einen Wert, älteste zuerst", () => {
    const samples = contextTimeline([turn(100), turn(200), turn(300)], [model])
    expect(samples.map((s) => s.tokens)).toEqual([100, 200, 300])
  })

  test("summiert alle Token-Buckets eines Turns", () => {
    const message = {
      id: "m",
      type: "assistant",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" },
      tokens: { input: 100, output: 200, reasoning: 300, cache: { read: 400, write: 500 } },
      cost: 0.5,
    } as unknown as SessionMessageInfo
    const samples = contextTimeline([message], [model])
    expect(samples[0]?.tokens).toBe(1500)
    expect(samples[0]?.cost).toBe(0.5)
  })

  test("stuft nach Prozentwert ein", () => {
    const samples = contextTimeline([turn(LIMIT * 0.5), turn(LIMIT * 0.75), turn(LIMIT * 0.95)], [model])
    expect(samples.map((s) => s.level)).toEqual(["ok", "warning", "error"])
  })

  test("ohne Modell-Limit bleibt der Grad ok", () => {
    const samples = contextTimeline([turn(9_000_000)], [])
    expect(samples[0]?.percent).toBeUndefined()
    expect(samples[0]?.level).toBe("ok")
  })

  test("markiert den Turn direkt nach einer Kompaktierung, nicht dauerhaft", () => {
    const samples = contextTimeline([turn(100), compaction(), turn(50), turn(60)], [model])
    expect(samples.map((s) => s.compacted)).toEqual([false, true, false])
  })

  test("ignoriert Turns ohne Usage", () => {
    const empty = { id: "e", type: "assistant", model: { providerID: "p", id: "m" } } as unknown as SessionMessageInfo
    expect(contextTimeline([turn(100), empty], [model])).toHaveLength(1)
  })

  test("schneidet am Revert-Punkt ab", () => {
    const messages = [turn(100, 0.01, "a"), turn(200, 0.01, "b"), turn(300, 0.01, "c")]
    expect(contextTimeline(messages, [model], "c").map((s) => s.tokens)).toEqual([100, 200])
  })

  test("unbekannte Revert-Grenze liefert eine leere Timeline", () => {
    expect(contextTimeline([turn(100)], [model], "gibt_es_nicht")).toEqual([])
  })

  test("leere Message-Liste ist unkritisch", () => {
    expect(contextTimeline([], [model])).toEqual([])
  })
})
