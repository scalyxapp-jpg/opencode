// Prüft, wie das Plugin mit tatsächlichen Modellantworten umgeht:
// abgebrochene Arrays, Codezäune mit Prosa, Listen in Objekten, robuste
// Feldnamen und Maskierung. Rein lokal, ohne Netz.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-5-answers-${process.pid}.mjs`)

writeFileSync(
  STAGED,
  readFileSync(SOURCE, "utf8") + "\nexport { parseSuggestions, salvageSuggestions, toSuggestion }\n",
)

const { parseSuggestions, salvageSuggestions, toSuggestion } = await import(STAGED + "?t=" + Date.now())

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

const titles = (list) => list.map((item) => item.title).join("|")

// 1. Abgebrochene Antwort: das Array ist offen, die ersten Einträge stehen ganz da.
const truncated =
  '[{"kind":"Erweitern","title":"A","detail":"d1"},{"kind":"Vertiefen","title":"B","detail":"d2"},{"kind":"Absichern","tit'
const salvaged = parseSuggestions(truncated)
check("abgebrochene Antwort wird gerettet", titles(salvaged) === "A|B", titles(salvaged))
check("die Richtung bleibt erhalten", salvaged[0]?.detail?.startsWith("Erweitern"), String(salvaged[0]?.detail))
check("der abgeschnittene Eintrag fehlt", !titles(salvaged).includes("Absichern"))

// 2. Codezaun und Prosa drumherum.
const fenced = 'Hier sind sie:\n```json\n[{"kind":"Erweitern","title":"X","detail":"d"}]\n```\nViel Erfolg.'
check("Codezaun mit Prosa wird vertragen", titles(parseSuggestions(fenced)) === "X", titles(parseSuggestions(fenced)))

// 3. Liste in einem Objekt, auch mit deutschem Schlüssel.
const wrapped = '{"summary":"s","suggestions":[{"kind":"Erweitern","title":"Y","detail":"d"}]}'
check(
  "Liste in einem Objekt wird gefunden",
  titles(parseSuggestions(wrapped)) === "Y",
  titles(parseSuggestions(wrapped)),
)
const wrappedGerman = '{"summary":"s","vorschläge":[{"kind":"Erweitern","title":"Z","detail":"d"}]}'
check(
  "deutscher Sammelschlüssel wird gefunden",
  titles(parseSuggestions(wrappedGerman)) === "Z",
  titles(parseSuggestions(wrappedGerman)),
)

// 4. Robuste Feldnamen.
const robust = '[{"art":"Vertiefen","titel":"T1","begruendung":"b1","auftrag":"p1"}]'
const robustOut = parseSuggestions(robust)
check("deutsche Feldnamen werden gelesen", titles(robustOut) === "T1", titles(robustOut))
check("der Auftrag wird uebernommen", robustOut[0]?.prompt === "p1", String(robustOut[0]?.prompt))
check(
  "die Richtung steht im Detail",
  String(robustOut[0]?.detail).startsWith("Vertiefen"),
  String(robustOut[0]?.detail),
)

// 5. Maskierung: Klammern und Anfuehrungszeichen in Zeichenketten zaehlen nicht.
const escaped = '[{"title":"A \\"B\\" {x}","detail":"d"},{"title":"C'
const escapedOut = parseSuggestions(escaped)
check("Maskierung wird beachtet", titles(escapedOut) === 'A "B" {x}', titles(escapedOut))

// 6. Unvollstaendiges Objekt wird verworfen, nicht geraten.
check("unvollstaendiges Objekt faellt weg", salvageSuggestions('[{"title":"A","detail":"x"},{"title":').length === 1)

// 7. Rettung ohne Objekte ergibt nichts.
check("ohne Objekte keine Rettung", salvageSuggestions("nur Prosa, kein JSON").length === 0)

// 8. Markdown-Liste bleibt unveraendert in Kraft (Richtung im Kopf).
const listed = parseSuggestions("- Erweitern — Neue Ansicht\n- Vertiefen — Struktur aufraeumen")
check("Markdown-Liste wird weiterhin gelesen", titles(listed) === "Neue Ansicht|Struktur aufraeumen", titles(listed))

// 9. Ein einzelner Eintrag bleibt moeglich (Rohtext-Notausgang unveraendert).
check("einzelner Rohtext bleibt ein Eintrag", parseSuggestions("Mach irgendwas").length === 1)

// 10. toSuggestion raeumt Muell weg.
check("ohne Titel kein Eintrag", toSuggestion({ detail: "d" }) === undefined)
check("Nicht-Objekt kein Eintrag", toSuggestion(7) === undefined)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
