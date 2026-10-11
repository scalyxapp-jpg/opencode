delete process.env.NVIDIA_API_KEY // Tests bleiben offline
// Prüft die echten Funktionen aus fork/plugins/auto-suggest/tui.js,
// ohne die Datei selbst zu verändern: Quelltext lesen, interne Namen
// zusätzlich exportieren, als Daten-URL importieren.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-1-evidence-${process.pid}.mjs`)

const source = readFileSync(SOURCE, "utf8")
writeFileSync(STAGED, source + "\nexport { buildPrompt, collectEvidence, parseSuggestions, KINDS, kindOf, withKind }\n")

const mod = await import(STAGED + "?t=" + Date.now())
const { buildPrompt, parseSuggestions, KINDS, kindOf, withKind } = mod

let pass = 0
let fail = 0
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

console.log("KINDS und Reihenfolge")
check("vier Richtungen", KINDS.length === 4, JSON.stringify(KINDS))
check("Erweitern zuerst", KINDS[0] === "Erweitern", KINDS[0])
check("Absichern zuletzt", KINDS[3] === "Absichern", KINDS[3])
check(
  "alle vier vorhanden",
  ["Erweitern", "Vertiefen", "Fortsetzen", "Absichern"].every((k) => KINDS.includes(k)),
)

console.log("kindOf")
check("nimmt Erweitern", kindOf("Erweitern") === "Erweitern")
check("ist case-tolerant", kindOf("erweitern") === "Erweitern")
check("verwirft Unbekanntes", kindOf("Sonstiges") === "")
check("verwirft leer", kindOf(undefined) === "")

console.log("withKind")
check("stellt Richtung voran", withKind("Erweitern", "Detail").startsWith("Erweitern · Detail"))
check("ohne Richtung nur Detail", withKind("", "Detail") === "Detail")

const evidence = {
  turns: 6,
  totalTurns: 6,
  asks: ["baue eine Export-Funktion ein"],
  edited: ["src/export.ts"],
  readOnly: ["src/store.ts"],
  code: ["src/export.ts"],
  tests: [],
  docs: [],
  manifests: [],
  commands: ["bun test src/export.test.ts"],
  failures: [],
  plans: [],
  signals: ["Code wurde geändert, aber keine Testdatei angefasst"],
  mode: "Umsetzen",
  lastClaim: "Export steht, Tests fehlen noch.",
  root: "/home/scalyxsoft/projekt",
}

console.log("buildPrompt")
const prompt = buildPrompt(evidence, "mehr Ideen")
check("nennt Schwerpunkt Ausbau", prompt.includes("Der Schwerpunkt liegt auf dem Ausbau"))
check("nennt Absicherung als Ausnahme", prompt.includes("Absicherung ist die Ausnahme"))
check("verlangt eine Erweitern-Mehrheit", prompt.includes('Die Mehrheit sind "Erweitern": mindestens die Hälfte'))
check("begrenzt Fortsetzen auf einen", prompt.includes('Höchstens einer ist "Fortsetzen"'))
check("begrenzt Absichern auf einen", /höchstens einer ist "Absichern"/.test(prompt))
check("alte Zwei-Fortsetzen-Regel weg", !prompt.includes("Höchstens zwei Vorschläge"))
check("listet Erweitern zuerst", prompt.indexOf('"Erweitern"') < prompt.indexOf('"Absichern"'))
check("Belege enthalten", prompt.includes("src/export.ts"))
check("Nutzeranfrage zitiert", prompt.includes(JSON.stringify("baue eine Export-Funktion ein")))
check("Fokus eingebaut", prompt.includes("Besonderes Augenmerk: mehr Ideen"))
check("Antwortformat JSON", prompt.includes("Antworte jetzt ausschließlich mit einem JSON-Array"))
check("Anweisung vor den Belegen", prompt.indexOf("AUFGABE") < prompt.indexOf("BELEGE"))
check("Lücken als Kontext markiert", prompt.includes("keine Pflichtliste"))

console.log("parseSuggestions")
const answer = JSON.stringify([
  { kind: "Erweitern", title: "Filter-Export ergänzen", detail: "Auf src/export.ts aufbauen" },
  { kind: "Erweitern", title: "CSV-Ausgabe", detail: "Zweites Zielformat" },
  { kind: "Fortsetzen", title: "Tests schreiben", detail: "src/export.ts ist ungeprüft" },
  { kind: "Absichern", title: "Regression prüfen", detail: "Keine Testdatei angefasst" },
])
const parsed = parseSuggestions(answer)
check("vier Vorschläge gelesen", parsed.length === 4, String(parsed.length))
check("Richtung steht im Detail", parsed[0].detail.startsWith("Erweitern · "))
check("zwei Erweitern", parsed.filter((p) => p.detail.startsWith("Erweitern")).length === 2)
check(
  "unbekannte Richtung wird verworfen",
  parseSuggestions(JSON.stringify([{ kind: "Quatsch", title: "X", detail: "y" }]))[0].detail === "y",
)

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
