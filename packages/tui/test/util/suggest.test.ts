import { describe, expect, test } from "bun:test"
import { parseSuggestions } from "../../src/util/suggest"

const json = (value: unknown) => JSON.stringify(value)

describe("parseSuggestions", () => {
  test("liest das erwartete JSON-Array", () => {
    const result = parseSuggestions(
      json([
        { title: "Fehlerpfad abdecken", detail: "Der Zweig ist ungetestet." },
        { title: "Logging aufräumen", detail: "Drei tote Aufrufe." },
      ]),
    )
    expect(result.shape).toBe("json")
    expect(result.suggestions).toHaveLength(2)
    expect(result.suggestions[0]?.title).toBe("Fehlerpfad abdecken")
    expect(result.suggestions[0]?.detail).toBe("Der Zweig ist ungetestet.")
  })

  test("liest JSON aus einem Codezaun", () => {
    const result = parseSuggestions('Hier die Vorschläge:\n```json\n[{"title":"A","detail":"B"}]\n```\n')
    expect(result.shape).toBe("json")
    expect(result.suggestions[0]?.title).toBe("A")
  })

  test("liest JSON mit erklärendem Text davor und danach", () => {
    const result = parseSuggestions('Klar! [{"title":"A","detail":"B"}] Hoffe das hilft.')
    expect(result.shape).toBe("json")
    expect(result.suggestions).toHaveLength(1)
  })

  test("verschluckt sich nicht an Klammern in Strings", () => {
    const result = parseSuggestions('[{"title":"Fix [x] Array","detail":"wegen ] im Text"}]')
    expect(result.shape).toBe("json")
    expect(result.suggestions[0]?.title).toBe("Fix [x] Array")
  })

  test("verkraftet Zeilenumbrüche im JSON", () => {
    const result = parseSuggestions('[\n  {\n    "title": "A",\n    "detail": "B"\n  }\n]')
    expect(result.suggestions[0]?.title).toBe("A")
  })

  test("akzeptiert abweichende Feldnamen", () => {
    const result = parseSuggestions(
      json([
        { name: "A", reason: "weil" },
        { step: "B", why: "darum" },
      ]),
    )
    expect(result.suggestions.map((s) => s.title)).toEqual(["A", "B"])
    expect(result.suggestions.map((s) => s.detail)).toEqual(["weil", "darum"])
  })

  test("akzeptiert ein Array aus reinen Strings", () => {
    const result = parseSuggestions(json(["Erstens", "Zweitens"]))
    expect(result.suggestions.map((s) => s.title)).toEqual(["Erstens", "Zweitens"])
    expect(result.suggestions[0]?.detail).toBe("")
  })

  test("fällt auf eine Markdown-Liste zurück", () => {
    const result = parseSuggestions(
      "- Tests ergänzen — der Zweig ist ungetestet\n- Logging aufräumen — drei tote Aufrufe",
    )
    expect(result.shape).toBe("list")
    expect(result.suggestions[0]).toEqual({ title: "Tests ergänzen", detail: "der Zweig ist ungetestet" })
  })

  test("erkennt nummerierte Listen", () => {
    const result = parseSuggestions("1. Erstens\n2) Zweitens")
    expect(result.shape).toBe("list")
    expect(result.suggestions.map((s) => s.title)).toEqual(["Erstens", "Zweitens"])
  })

  test("eine einzelne Listenzeile ist noch keine Liste", () => {
    const result = parseSuggestions("- nur ein Punkt")
    expect(result.shape).toBe("raw")
  })

  test("Rohtext wird zum einzelnen Vorschlag statt verworfen", () => {
    const result = parseSuggestions("Ich würde als Nächstes die Tests fertigstellen.")
    expect(result.shape).toBe("raw")
    expect(result.suggestions[0]?.title).toContain("Tests fertigstellen")
  })

  test("leere Antwort ergibt keine Vorschläge", () => {
    expect(parseSuggestions("")).toEqual({ suggestions: [], shape: "empty" })
    expect(parseSuggestions("   \n  ")).toEqual({ suggestions: [], shape: "empty" })
  })

  test("kaputtes JSON rutscht auf die nächste Stufe statt zu werfen", () => {
    const result = parseSuggestions('[{"title": "A",]')
    expect(result.shape).not.toBe("empty")
  })

  test("Objekte ohne Titel werden verworfen", () => {
    const result = parseSuggestions(json([{ detail: "kein Titel" }, { title: "B", detail: "ok" }]))
    expect(result.suggestions.map((s) => s.title)).toEqual(["B"])
  })

  test("lange Titel und Details werden gekürzt", () => {
    const result = parseSuggestions(json([{ title: "x".repeat(400), detail: "y".repeat(900) }]))
    expect(result.suggestions[0]!.title.length).toBeLessThanOrEqual(120)
    expect(result.suggestions[0]!.detail.length).toBeLessThanOrEqual(240)
  })

  test("mehr als sechs Vorschläge werden beschnitten", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `V${i}`, detail: "" }))
    expect(parseSuggestions(json(many)).suggestions).toHaveLength(6)
  })

  test("ignoriert Leerstrings und Nicht-Objekte im Array", () => {
    const result = parseSuggestions(json([null, 42, "  ", { title: "Gültig" }]))
    expect(result.suggestions.map((s) => s.title)).toEqual(["Gültig"])
  })
})
