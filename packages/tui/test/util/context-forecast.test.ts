import { describe, expect, test } from "bun:test"
import { forecastContext, type ContextSample } from "../../src/util/session"

const LIMIT = 1_048_576

const sample = (tokens: number, compacted = false): ContextSample => ({
  tokens,
  percent: Math.round((tokens / LIMIT) * 100),
  level: "ok",
  compacted,
  cost: 0.01,
})

describe("forecastContext", () => {
  test("braucht mindestens drei Messpunkte", () => {
    expect(forecastContext([], LIMIT)).toBeUndefined()
    expect(forecastContext([sample(100), sample(200)], LIMIT)).toBeUndefined()
  })

  test("schätzt gleichmäßiges Wachstum", () => {
    const forecast = forecastContext([sample(100), sample(110), sample(120), sample(130), sample(140)], LIMIT)
    expect(forecast?.perTurn).toBe(10)
    expect(forecast?.confidence).toBe("high")
    expect(forecast?.turnsLeft).toBe(Math.floor((LIMIT - 140) / 10))
  })

  test("nutzt den Median, damit ein Riesenturn nicht verzerrt", () => {
    // 10, 10, 10, dann ein Ausreißer von 10000
    const forecast = forecastContext([sample(100), sample(110), sample(120), sample(130), sample(10_130)], LIMIT)
    expect(forecast?.perTurn).toBe(10)
  })

  test("eine Kompaktierung im Fenster senkt die Zuversicht auf low", () => {
    const samples = [sample(100), sample(110), sample(120, true), sample(130), sample(140), sample(150)]
    expect(forecastContext(samples, LIMIT)?.confidence).toBe("low")
  })

  test("ohne Limit keine Turn-Prognose, aber die Rate schon", () => {
    const forecast = forecastContext([sample(100), sample(120), sample(140)], undefined)
    expect(forecast?.perTurn).toBe(20)
    expect(forecast?.turnsLeft).toBeUndefined()
  })

  test("schrumpfender Verlauf prognostiziert nichts", () => {
    const forecast = forecastContext([sample(500), sample(400), sample(300), sample(200)], LIMIT)
    expect(forecast?.perTurn).toBeLessThanOrEqual(0)
    expect(forecast?.turnsLeft).toBeUndefined()
    expect(forecast?.confidence).toBe("low")
  })

  test("bereits über dem Limit: null Turns übrig", () => {
    const forecast = forecastContext([sample(100), sample(200), sample(LIMIT + 1000)], LIMIT)
    expect(forecast?.turnsLeft).toBe(0)
  })

  test("kurzes Fenster ergibt nur mittlere Zuversicht", () => {
    const forecast = forecastContext([sample(100), sample(120), sample(140)], LIMIT)
    expect(forecast?.confidence).toBe("medium")
    expect(forecast?.window).toBe(2)
  })

  test("berücksichtigt nur das konfigurierte Fenster", () => {
    // Früher Wert 1000, dann gleichmäßig +50 — das Fenster soll den Ausreißer nicht sehen
    const samples = [sample(1000), sample(1050), sample(1100), sample(1150)]
    expect(forecastContext(samples, LIMIT, 2)?.perTurn).toBe(50)
  })
})
