delete process.env.NVIDIA_API_KEY // Tests bleiben offline
// Prüft die Anzahl-Logik der Suggestions gegen die echten Funktionen.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-2-budget-${process.pid}.mjs`)

const source = readFileSync(SOURCE, "utf8")
writeFileSync(
  STAGED,
  source +
    "\nexport { buildPrompt, parseSuggestions, normalizeSuggestions, suggestionBudget, KINDS, MIN_SUGGESTIONS, MAX_SUGGESTIONS }\n",
)

const mod = await import(STAGED + "?t=" + Date.now())
const { buildPrompt, parseSuggestions, normalizeSuggestions, suggestionBudget, MIN_SUGGESTIONS, MAX_SUGGESTIONS } = mod

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

const evidence = (over = {}) => ({
  mode: "Umsetzen",
  turns: 6,
  totalTurns: 8,
  asks: [],
  edited: [],
  readOnly: [],
  code: [],
  tests: [],
  docs: [],
  manifests: [],
  commands: [],
  failures: [],
  plans: [],
  signals: [],
  lastClaim: "",
  root: "",
  ...over,
})

const spread = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

console.log("Grenzen")
check("MIN_SUGGESTIONS ist 3", MIN_SUGGESTIONS === 3, String(MIN_SUGGESTIONS))
check("MAX_SUGGESTIONS ist 10", MAX_SUGGESTIONS === 10, String(MAX_SUGGESTIONS))
check("MAX ueber MIN", MAX_SUGGESTIONS > MIN_SUGGESTIONS)

console.log("suggestionBudget")
check("leere Belege -> 3", suggestionBudget(evidence()) === MIN_SUGGESTIONS, String(suggestionBudget(evidence())))
check("6 Anker -> 5", suggestionBudget(evidence({ edited: ["a", "b", "c", "d", "e", "f"] })) === 5)
check(
  "10 Anker -> 5",
  suggestionBudget(evidence({ edited: ["a", "b", "c", "d", "e", "f", "g"], commands: ["x", "y", "z"] })) === 5,
)
check(
  "11 Anker -> 7",
  suggestionBudget(evidence({ edited: ["a", "b", "c", "d", "e", "f", "g", "h"], commands: ["x", "y", "z"] })) === 7,
)
check(
  "17 Anker -> 9",
  suggestionBudget(
    evidence({
      edited: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      commands: ["w", "x", "y", "z"],
      asks: ["p", "q", "r", "s"],
    }),
  ) === 9,
)
check(
  "sehr reich bleibt <= MAX",
  suggestionBudget(
    evidence({
      edited: Array.from({ length: 14 }, (_, i) => `f${i}`),
      commands: Array.from({ length: 14 }, (_, i) => `c${i}`),
      asks: Array.from({ length: 14 }, (_, i) => `a${i}`),
    }),
  ) <= MAX_SUGGESTIONS,
)
check("MAX ist 10", MAX_SUGGESTIONS === 10, String(MAX_SUGGESTIONS))

console.log("normalizeSuggestions")
const dupes = normalizeSuggestions([
  { title: "Fix A", detail: "eins" },
  { title: "fix a", detail: "zwei" },
  { title: "  Fix A  ", detail: "drei" },
  { title: "Fix B", detail: "" },
])
check(
  "entfernt Duplikate ohne Ruecksicht auf Schreibweise",
  dupes.length === 2,
  JSON.stringify(dupes.map((d) => d.title)),
)
check("behaelt die erste Fassung", dupes[0].detail === "eins", dupes[0].detail)
check("schneidet den Titel", dupes[1].title === "Fix B")
check("verwirft leere Titel", normalizeSuggestions([{ title: "   " }, { title: "Echt" }]).length === 1)

const many = normalizeSuggestions(Array.from({ length: 30 }, (_, i) => ({ title: `Idee ${i}` })))
check("begrenzt auf MAX_SUGGESTIONS", many.length === MAX_SUGGESTIONS, String(many.length))

console.log("parseSuggestions: Obergrenze")
const fifteen = JSON.stringify(
  Array.from({ length: 15 }, (_, i) => ({ kind: "Erweitern", title: `Idee ${i}`, detail: `weil ${i}` })),
)
const parsedFifteen = parseSuggestions(fifteen)
check("JSON liefert hoechstens 10", parsedFifteen.length === MAX_SUGGESTIONS, String(parsedFifteen.length))
check("mehr als 5 moeglich", parsedFifteen.length > 5, String(parsedFifteen.length))

const eight = JSON.stringify(
  Array.from({ length: 8 }, (_, i) => ({ kind: "Vertiefen", title: `Sache ${i}`, detail: `d${i}` })),
)
check("acht werden durchgelassen", parseSuggestions(eight).length === 8, String(parseSuggestions(eight).length))

console.log("parseSuggestions: Markdown mit Richtung im Kopf")
const md = [
  "- Erweitern — neuer Export",
  "- Vertiefen: Nebenlaeufigkeit klaeren",
  "- Absichern — Randfall decken",
].join("\n")
const mdItems = parseSuggestions(md)
check("drei Eintraege", mdItems.length === 3, String(mdItems.length))
check("Richtung wird nicht zum Titel", mdItems[0].title === "neuer Export", mdItems[0].title)
check("Richtung steht im Detail", mdItems[0].detail === "Erweitern", mdItems[0].detail)
check("Doppelpunkt als Trenner", mdItems[1].title === "Nebenlaeufigkeit klaeren", mdItems[1].title)
check("Richtung im Detail erkannt", mdItems[2].detail === "Absichern", mdItems[2].detail)
check("dritter Eintrag gelesen", mdItems[2].title === "Randfall decken", mdItems[2].title)

const mdPlain = ["- Titel eins — Beschreibung eins", "- Titel zwei: Beschreibung zwei"].join("\n")
const plainItems = parseSuggestions(mdPlain)
check("ohne Richtung bleibt der Kopf der Titel", plainItems[0].title === "Titel eins", plainItems[0].title)
check("ohne Richtung Detail als Text", plainItems[0].detail === "Beschreibung eins", plainItems[0].detail)

const mdDupes = ["- Erweitern — gleiche Sache", "- Vertiefen — gleiche Sache"].join("\n")
check(
  "Markdown-Duplikate zusammengefasst",
  parseSuggestions(mdDupes).length === 1,
  String(parseSuggestions(mdDupes).length),
)

console.log("buildPrompt: Anzahl und Regeln")
const fixed = buildPrompt(evidence())
check("leichte Session nennt die Zahl", fixed.includes("Schlage 3 nächste Arbeiten vor"), fixed.slice(0, 70))
check("Untergrenze steht im Auftrag", fixed.includes("Mehr als 3 werden es nie."))
check("auffuellen ist verboten", fixed.includes("auffüllen ist verboten"))
check("kein 'genau 10' mehr", !fixed.includes("genau 10"))

const rich = buildPrompt(
  evidence({
    edited: spread("src/a", 9),
    commands: spread("bun run x", 5),
    asks: spread("bitte ", 3),
    signals: ["Code geaendert, aber kein Test"],
  }),
  undefined,
)

check("kein 'vier bis fünf' mehr", !rich.includes("vier bis fünf"))
check("Regel gegen Ueberschneidung", rich.includes("Zwei Vorschläge dürfen sich nicht überschneiden"))
check("Erweitern-Anteil skaliert", rich.includes("ab sechs Vorschlägen mindestens zwei Drittel"))
check("Erweitern ist die Mehrheit", rich.includes('Die Mehrheit sind "Erweitern"'))
check("ein Erweitern ist ein vollstaendiges Feature", rich.includes("vollständiges Feature, kein Detail"))
check("das Feature verbessert die Nutzung", rich.includes("verbessert die Nutzung"))
check("Fortsetzen/Absichern skalieren", rich.includes("ab acht Vorschlägen höchstens zwei"))
check("Erweitern vor Absichern gelistet", rich.indexOf('"Erweitern" —') < rich.indexOf('"Absichern" —'))
check("Schwerpunkt bleibt Ausbau", rich.includes("Absicherung ist die Ausnahme"))
check("Belege stehen hinter der Anweisung", rich.indexOf("BELEGE") > rich.indexOf("AUFGABE"))
check("Antwortformat verlangt ein prompt-Feld", rich.includes('"prompt"'), "")
check("prompt wird als fertiger Auftrag verlangt", rich.includes("wortgleich in den Chat geht"))
check(
  "blosse Wiederholung des Titels wird ausgeschlossen",
  rich.includes("Eine bloße Wiederholung des `title` genügt nicht"),
)

// "Android" waere inzwischen ein Bereich und damit ein Filter; fuer den reinen
// Hinweis muss ein Wort her, das kein Bereich ist.
const focused = buildPrompt(evidence({ edited: ["a.ts"] }), "Barrierefreiheit")
check("reiche Session nennt 3 bis 9", rich.includes("Schlage 3 bis 9 nächste Arbeiten vor"), "")
check("reiche Session nennt 9 als Grenze", rich.includes("Mehr als 9 werden es nie."))
check("Fokus wird als letzte Regel angehaengt", focused.includes("Besonderes Augenmerk: Barrierefreiheit"))
check("Fokus bleibt optionale Regel 8", focused.includes("8. Besonderes Augenmerk: Barrierefreiheit"))

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
