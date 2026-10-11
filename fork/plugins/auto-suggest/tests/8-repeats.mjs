// Prüft die Sperre gegen Wiederholungen: was schon vorgeschlagen wurde, darf
// kein zweites Mal kommen — auch nicht mit anderen Worten. Rein lokal.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-8-repeats-${process.pid}.mjs`)

writeFileSync(
  STAGED,
  readFileSync(SOURCE, "utf8") +
    "\nexport { titleTokens, sameWork, isRepeat, freshSuggestions, askedBlock, strictReminder, areaTemplate, ensureAreaSuggestions, buildPrompt, buildProjectPrompt, PROJECT_AREAS }\n",
)

const mod = await import(STAGED + "?t=" + Date.now())
const {
  titleTokens,
  sameWork,
  isRepeat,
  freshSuggestions,
  askedBlock,
  strictReminder,
  areaTemplate,
  ensureAreaSuggestions,
  buildPrompt,
  buildProjectPrompt,
  PROJECT_AREAS,
} = mod

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
const areaOf = (key) => PROJECT_AREAS.find((area) => area.key === key)

console.log("titleTokens: vergleichbar machen")
check(
  "Kleinschreibung und Satzzeichen fallen weg",
  titleTokens("Tests für src/a.ts!").join(",") === "tests,src/a.ts",
  titleTokens("Tests für src/a.ts!").join(","),
)
check(
  "Fuellwoerter fallen weg",
  !titleTokens("Tests für die geänderten Dateien").includes("für"),
  titleTokens("Tests für die geänderten Dateien").join(","),
)
check("ein Pfad bleibt ein Wort", titleTokens("Tests für src/a.ts").includes("src/a.ts"))
check("leerer Titel ergibt nichts", titleTokens("   ").length === 0)

console.log("")
console.log("sameWork: dieselbe Arbeit in anderen Worten")
check("gleicher Titel", sameWork("Tests nachziehen", "Tests nachziehen") === true)
check("andere Schreibweise", sameWork("Tests für src/a.ts", "tests fuer src/a.ts") === true)
check(
  "Kern mit Anhang zaehlt als Wiederholung",
  sameWork("Tests für src/a.ts", "Tests für src/a.ts nachziehen") === true,
)
check(
  "zwei verschiedene Dateien sind nicht dieselbe Arbeit",
  sameWork("Tests für src/a.ts", "Tests für src/b.ts") === false,
)
check(
  "verlaengerte Ansicht zaehlt als Wiederholung",
  sameWork("Neue Ansicht für Profile", "Neue Ansicht für Profile mit Verlauf") === true,
)
check(
  "verschiedene Bereiche sind verschieden",
  sameWork("Architektur um einen Baustein erweitern", "Oberfläche um einen Bedienweg erweitern") === false,
)
check("ohne Worte keine Gleichheit", sameWork("", "Tests") === false)
check("ein einzelnes Wort vergleicht nur mit sich selbst", sameWork("Tests", "Tests für das Projekt anlegen") === false)

console.log("")
console.log("isRepeat und freshSuggestions")
const seen = ["Neue Ansicht für Profile", "Tests für src/a.ts"]
check("gleicher Titel ist eine Wiederholung", isRepeat("Neue Ansicht für Profile", seen) === true)
check("anderer Wortlaut derselben Arbeit ebenso", isRepeat("Neue Ansicht für Profile ausbauen", seen) === true)
check("Unbekanntes ist keine Wiederholung", isRepeat("Datenbankabfragen bündeln", seen) === false)
check("ohne Liste keine Wiederholung", isRepeat("Neue Ansicht für Profile", []) === false)
const list = [
  { title: "Neue Ansicht für Profile" },
  { title: "Datenbankabfragen bündeln" },
  { title: "Tests für src/a.ts nachziehen" },
]
check("nur das Neue bleibt", freshSuggestions(list, seen).length === 1, JSON.stringify(freshSuggestions(list, seen)))
check("und zwar das richtige", freshSuggestions(list, seen)[0]?.title === "Datenbankabfragen bündeln")
check("ohne Liste bleibt alles", freshSuggestions(list, []).length === 3)

console.log("")
console.log("Was dem Modell gesagt wird")
check("ohne Liste kein Block", askedBlock([]) === "")
const block = askedBlock(seen)
check("die Liste steht im Block", block.includes("Neue Ansicht für Profile") && block.includes("Tests für src/a.ts"))
check("der Block verbietet die Wiederholung", block.includes("nichts davon erneut anbieten"))
check("gleicher Gedanke, andere Worte zaehlt als Wiederholung", block.includes("anderen Worten gilt als Wiederholung"))
check("weniger ist erlaubt statt Wiederholung", block.includes("liefere weniger"))
check(
  "der Nachdruck nennt den Grund",
  strictReminder().includes("ACHTUNG") && strictReminder().includes("BEREITS VORGESCHLAGEN"),
)

console.log("")
console.log("Der Block steht in beiden Auftraegen")
const evidence = {
  mode: "Umsetzen",
  totalTurns: 2,
  turns: 2,
  asks: ["bau das"],
  edited: ["a.ts"],
  readOnly: [],
  tests: [],
  docs: [],
  manifests: [],
  plans: [],
  commands: [],
  failures: [],
  signals: [],
  lastClaim: "",
}
const sessionPrompt = buildPrompt(evidence, undefined, seen)
check(
  "der Sitzungsauftrag nennt die Liste",
  sessionPrompt.includes("BEREITS VORGESCHLAGEN") && sessionPrompt.includes("Tests für src/a.ts"),
)
check(
  "ohne Liste steht nichts davon drin",
  buildPrompt(evidence, undefined, []).includes("BEREITS VORGESCHLAGEN") === false,
)
const projectPrompt = buildProjectPrompt(
  "/projekt",
  { text: "PROJEKT", files: ["src/a.ts"], count: 1 },
  [],
  undefined,
  undefined,
  seen,
)
check(
  "der Projektauftrag nennt die Liste",
  projectPrompt.includes("BEREITS VORGESCHLAGEN") && projectPrompt.includes("Neue Ansicht für Profile"),
)
check(
  "ohne Liste steht nichts davon drin",
  buildProjectPrompt("/projekt", { text: "P", files: [], count: 0 }, [], undefined, undefined, []).includes(
    "BEREITS VORGESCHLAGEN",
  ) === false,
)

console.log("")
console.log("Pflichtbereiche wiederholen sich nicht")
const gui = areaOf("gui")
check(
  "die erste Vorlage gilt ohne Liste",
  areaTemplate(gui, [])?.title === "Oberfläche um einen Bedienweg erweitern",
  String(areaTemplate(gui, [])?.title),
)
check(
  "die zweite, wenn die erste dran war",
  areaTemplate(gui, ["Oberfläche um einen Bedienweg erweitern"])?.title === "Oberfläche um eine neue Ansicht erweitern",
  String(areaTemplate(gui, ["Oberfläche um einen Bedienweg erweitern"])?.title),
)
const allGui = [
  "Oberfläche um einen Bedienweg erweitern",
  "Oberfläche um eine neue Ansicht erweitern",
  "Oberfläche um eine bessere Rückmeldung erweitern",
  "Oberfläche um einen weiteren Bedienweg erweitern",
]
check(
  "sind alle Wortlaute dran, gibt es keine Vorlage",
  areaTemplate(gui, allGui) === undefined,
  String(areaTemplate(gui, allGui)?.title),
)
check("unbekannter Bereich ergibt keine Vorlage", areaTemplate({ key: "gibtsnicht" }, []) === undefined)
const areas = [{ ...gui, samples: ["app/App.tsx"] }]
const first = ensureAreaSuggestions([], areas, 5, [])
check(
  "ohne Liste kommt die erste Vorlage",
  first[0]?.title === "Oberfläche um einen Bedienweg erweitern" && first[0]?.area === "gui",
)
const second = ensureAreaSuggestions([], areas, 5, ["Oberfläche um einen Bedienweg erweitern"])
check("danach die naechste", second[0]?.title === "Oberfläche um eine neue Ansicht erweitern", String(second[0]?.title))
check(
  "und alle Vorlagen dran: kein Pflichtvorschlag statt Wiederholung",
  ensureAreaSuggestions([], areas, 5, allGui).length === 0,
)
check(
  "was das Modell liefert, wird nicht verdraengt",
  ensureAreaSuggestions([{ area: "gui", title: "Schon da" }], areas, 5, []).length === 1,
)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
