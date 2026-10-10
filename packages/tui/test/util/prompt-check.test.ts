import { describe, expect, test } from "bun:test"
import { analyzePrompt, verdictLine, worstLevel } from "../../src/util/prompt-check"

const codes = (text: string, exists?: (r: string) => boolean) => analyzePrompt(text, exists).findings.map((f) => f.code)

describe("analyzePrompt", () => {
  test("leerer Prompt erzeugt keinen Befund", () => {
    expect(analyzePrompt("").findings).toEqual([])
    expect(analyzePrompt("   ").findings).toEqual([])
  })

  test("Slash-Kommandos werden nicht analysiert", () => {
    expect(analyzePrompt("/status").findings).toEqual([])
    expect(analyzePrompt("/compact").findings).toEqual([])
  })

  test("meldet fehlende Verankerung bei einem echten Auftrag", () => {
    const verdict = analyzePrompt(
      "analysiere im web und finde heraus welcher mcp server noetigt wird damit opencode den source code lesen kann",
    )
    expect(verdict.anchor).toBe("none")
    expect(verdict.findings.some((f) => f.code === "no-anchor")).toBe(true)
    expect(worstLevel(verdict)).toBe("info")
  })

  test("kurze Rückfragen werden nicht bemängelt", () => {
    // In der Historie sind 96-99 % der kurzen Prompts unverankert — das ist normal.
    for (const text of ["weiter", "ja mach das", "mach das", "fix das", "ok und weiter"]) {
      expect(analyzePrompt(text).findings).toEqual([])
    }
  })

  test("erkennt einen Pfad als Verankerung", () => {
    const verdict = analyzePrompt("analysiere packages/tui/src/util/session.ts und passe die fmt-Funktion an")
    expect(verdict.anchor).toBe("path")
    expect(verdict.references).toContain("packages/tui/src/util/session.ts")
    expect(verdict.findings.some((f) => f.code === "no-anchor")).toBe(false)
  })

  test("erkennt absolute Pfade und Punkt-Pfade", () => {
    expect(analyzePrompt("lies /home/x/proj/main.py").anchor).toBe("path")
    expect(analyzePrompt("prüfe ./src/index.ts auf fehler").anchor).toBe("path")
  })

  test("erkennt einen Symbolverweis ohne Pfad als Verankerung", () => {
    const verdict = analyzePrompt("fix SessionRunner.start so dass er nicht doppelt läuft")
    expect(verdict.anchor).toBe("symbol")
    expect(verdict.findings.some((f) => f.code === "no-anchor")).toBe(false)
  })

  test("Backtick-Referenz zählt als Symbol", () => {
    expect(analyzePrompt("schau dir `contextPressure()` an und passe die Schwelle an").anchor).toBe("symbol")
  })

  test("meldet nicht existierende Referenzen", () => {
    const verdict = analyzePrompt("bearbeite src/gibtsnicht.ts und passe package.json an", () => false)
    expect(verdict.missing).toEqual(["src/gibtsnicht.ts", "package.json"])
    expect(verdict.findings.some((f) => f.code === "anchor-missing")).toBe(true)
  })

  test("überspringt die Existenzprüfung ohne Prüffunktion", () => {
    const verdict = analyzePrompt("bearbeite src/gibtsnicht.ts")
    expect(verdict.missing).toEqual([])
    expect(verdict.findings.some((f) => f.code === "anchor-missing")).toBe(false)
  })

  test("sehr lange Prompts bekommen einen Hinweis", () => {
    expect(codes("x".repeat(2500))).toContain("too-long")
  })

  test("kriterienlose, verankerte Aufträge bekommen einen Hinweis", () => {
    expect(codes("schau dir src/app.ts an und verbessere die Ausgabe der Formatierung dort wo sie abbricht")).toContain("no-criteria")
  })

  test("eine fehlende Datei ist eine harte Warnung, kein Hinweis", () => {
    const verdict = analyzePrompt("bearbeite src/gibtsnicht.ts", () => false)
    expect(worstLevel(verdict)).toBe("warn")
  })

  test("Formulierungen mit Ergebnis zählen als Kriterium", () => {
    expect(codes("schau dir src/app.ts an, es muss danach grün sein")).not.toContain("no-criteria")
  })

  test(" Slash-Kommandos bleiben still", () => {
    expect(codes("/q")).toEqual([])
    expect(codes("/compact")).toEqual([])
  })

  const TASK =
    "analysiere im web und finde heraus welcher mcp server noetigt wird damit opencode den source code lesen kann"

  test("verdictLine liefert den schlimmsten Befund", () => {
    expect(verdictLine(analyzePrompt(TASK))).toContain("kein Pfad genannt")
  })

  test("die Begründung nennt die gemessene Historie", () => {
    expect(verdictLine(analyzePrompt(TASK))).toContain("Median 5 statt 1 Fehler")
  })

  test("ohne Befund liefert verdictLine nichts", () => {
    expect(verdictLine(analyzePrompt("weiter"))).toBeUndefined()
  })

  // Beispiele aus der echten Session-Historie dieser Installation.
  test("echter Prompt ohne Pfad fällt durch die Verankerungsprüfung", () => {
    expect(
      codes("analysiere im web und finde heraus was für ein mcp server benötigt wird damit das debuggen klappt"),
    ).toContain("no-anchor")
  })

  test("echter Prompt mit Pfad besteht die Verankerungsprüfung", () => {
    expect(codes("verbessere opencode massgebend in packages/tui/src/util/session.ts")).not.toContain("no-anchor")
  })

  test("gut verankerter Prompt ohne Befund", () => {
    const verdict = analyzePrompt(
      "passe fork/src/db.ts an: read-only Zugriff, query_only pragma, danach bun typecheck muss grün sein",
    )
    expect(verdict.findings).toEqual([])
    expect(worstLevel(verdict)).toBeUndefined()
    expect(verdictLine(verdict)).toBeUndefined()
  })
})
