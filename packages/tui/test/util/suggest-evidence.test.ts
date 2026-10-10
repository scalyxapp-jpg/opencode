import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { buildPrompt, collectEvidence } from "../../src/util/suggest"

type ToolInput = {
  name: string
  input?: Record<string, unknown>
  status?: "completed" | "error"
  error?: string
}

const assistant = (tools: ToolInput[], text?: string): SessionMessageInfo =>
  ({
    id: `m${Math.random()}`,
    type: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...tools.map((tool, index) => ({
        type: "tool",
        id: `c${index}`,
        name: tool.name,
        state:
          (tool.status ?? "completed") === "error"
            ? { status: "error", input: tool.input ?? {}, error: { type: "tool", message: tool.error ?? "failed" } }
            : { status: "completed", input: tool.input ?? {}, output: "ok", title: tool.name, metadata: {} },
      })),
    ],
  }) as unknown as SessionMessageInfo

describe("collectEvidence", () => {
  test("sammelt angefasste Dateien ohne Wiederholungen", () => {
    const evidence = collectEvidence([
      assistant([
        { name: "read", input: { filePath: "a.ts" } },
        { name: "edit", input: { filePath: "a.ts" } },
      ]),
      assistant([{ name: "write", input: { filePath: "b.ts" } }]),
    ])
    expect(evidence.files).toEqual(["a.ts", "b.ts"])
  })

  test("sammelt ausgeführte Befehle", () => {
    const evidence = collectEvidence([assistant([{ name: "bash", input: { command: "bun test" } }])])
    expect(evidence.commands).toEqual(["bun test"])
  })

  test("hält Fehlschläge mit Werkzeug, Ziel und Meldung fest", () => {
    const evidence = collectEvidence([
      assistant([{ name: "edit", input: { filePath: "x.ts" }, status: "error", error: "oldString not found" }]),
    ])
    expect(evidence.failures).toEqual([{ tool: "edit", target: "x.ts", error: "oldString not found" }])
  })

  test("zählt Turns und merkt sich die letzte Aussage", () => {
    const evidence = collectEvidence([assistant([], "erste"), assistant([], "zweite und letzte")])
    expect(evidence.turns).toBe(2)
    expect(evidence.lastClaim).toBe("zweite und letzte")
  })

  test("ignoriert Nutzer- und Systemnachrichten", () => {
    const messages = [
      { id: "u", type: "user", text: "mach" },
      { id: "s", type: "system", text: "x" },
    ] as unknown as SessionMessageInfo[]
    expect(collectEvidence(messages).turns).toBe(0)
  })

  test("leerer Verlauf ergibt leere Belege", () => {
    expect(collectEvidence([])).toEqual({ turns: 0, files: [], commands: [], failures: [], lastClaim: "" })
  })

  test("begrenzt die Zahl der Dateien", () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({ name: "read", input: { filePath: `f${i}.ts` } }))
    expect(collectEvidence([assistant(tools)]).files).toHaveLength(12)
  })

  test("kürzt sehr lange Befehle", () => {
    const evidence = collectEvidence([assistant([{ name: "bash", input: { command: "x".repeat(500) } }])])
    expect(evidence.commands[0]!.length).toBeLessThanOrEqual(100)
  })
})

describe("buildPrompt", () => {
  const base = { turns: 3, files: [], commands: [], failures: [], lastClaim: "" }

  test("nennt die Belege im Auftrag", () => {
    const prompt = buildPrompt({ ...base, files: ["a.ts", "b.ts"], commands: ["bun test"] })
    expect(prompt).toContain("Angefasste Dateien: a.ts, b.ts")
    expect(prompt).toContain("Ausgeführte Befehle: bun test")
  })

  test("listet Fehlschläge einzeln auf", () => {
    const prompt = buildPrompt({ ...base, failures: [{ tool: "edit", target: "x.ts", error: "not found" }] })
    expect(prompt).toContain("- edit auf x.ts: not found")
  })

  test("verbietet ausdrücklich das Erfinden", () => {
    const prompt = buildPrompt({ ...base, files: ["a.ts"] })
    expect(prompt).toContain("Erfinde keine Dateien, Funktionen, Tests oder Probleme")
    expect(prompt).toContain("stützen können")
  })

  test("erlaubt ein leeres Ergebnis, wenn die Belege nichts hergeben", () => {
    expect(buildPrompt(base)).toContain("leeres Array zurück")
  })

  test("ohne Belege sagt es das offen", () => {
    expect(buildPrompt(base)).toContain("Keine abgeschlossenen Arbeitsschritte")
  })

  test("Fokus wird angehängt, wenn angegeben", () => {
    expect(buildPrompt(base, "Performance")).toContain("Besonderes Augenmerk: Performance")
    expect(buildPrompt(base)).not.toContain("Besonderes Augenmerk")
  })

  test("die Anweisung steht vor und nach den Belegen", () => {
    // Ohne das gewinnt der Gesprächsverlauf gegen die Anweisung: das Modell
    // setzt den letzten Assistentensatz fort statt zu antworten.
    const prompt = buildPrompt({ ...base, files: ["a.ts"] })
    const first = prompt.indexOf("AUFGABE")
    const evidence = prompt.indexOf("BELEGE")
    const last = prompt.indexOf("Das erste Zeichen")
    expect(first).toBeLessThan(evidence)
    expect(evidence).toBeLessThan(last)
  })

  test("die letzte Aussage wird als Zitat markiert, nicht als Fliesstext", () => {
    const prompt = buildPrompt({ ...base, lastClaim: "Fertig. Nächster Schritt wäre" })
    expect(prompt).toContain('wörtliches Zitat: "Fertig. Nächster Schritt wäre"')
  })

  test("der Verlauf wird nicht als Beleg ausgegeben", () => {
    // Der Belegblock führt nur Fakten auf, keine erfundenen Einträge.
    const prompt = buildPrompt(base)
    expect(prompt).not.toContain("Angefasste Dateien")
    expect(prompt).not.toContain("Fehlgeschlagene Aufrufe")
  })
})
