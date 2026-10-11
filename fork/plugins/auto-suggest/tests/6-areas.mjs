// Prüft den Bereichsfilter: /nextProject Gui darf nur Vorschläge zur
// Oberfläche liefern, /nextProject Barrierefreiheit bleibt ein Hinweis.
// Rein lokal, ohne Netz.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-6-areas-${process.pid}.mjs`)

writeFileSync(
  STAGED,
  readFileSync(SOURCE, "utf8") +
    "\nexport { focusParts, filterByAreas, selectAreas, areaFallback, areaWords, ensureAreaSuggestions, ensureCoreAreas, detectAreas, buildPrompt, buildProjectPrompt, AREA_SYNONYMS, PROJECT_AREAS }\n",
)

const mod = await import(STAGED + "?t=" + Date.now())
const {
  focusParts,
  filterByAreas,
  selectAreas,
  areaFallback,
  areaWords,
  ensureAreaSuggestions,
  detectAreas,
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
const keys = (scope) => scope.areas.map((area) => area.key).join(",")
const areaOf = (key) => PROJECT_AREAS.find((area) => area.key === key)

console.log("focusParts: Argument lesen")
check('"Gui" wird zum Bereich gui', keys(focusParts("Gui")) === "gui", keys(focusParts("Gui")))
check("Kleinschreibung egal", keys(focusParts("gui")) === "gui")
check('"Tests" wird zum Bereich tests', keys(focusParts("Tests")) === "tests")
check('"Oberfläche" wird zum Bereich gui', keys(focusParts("Oberfläche")) === "gui")
check('"Architektur" wird zum Bereich architecture', keys(focusParts("Architektur")) === "architecture")
check('"Android" wird zum Bereich mobile', keys(focusParts("Android")) === "mobile")
check("mehrere Bereiche mit Komma", keys(focusParts("gui, tests")) === "gui,tests")
check("mehrere Bereiche mit Leerzeichen", keys(focusParts("gui tests")) === "gui,tests")
check("kein doppelter Bereich", keys(focusParts("gui GUI")) === "gui")
check(
  "ohne Bereich bleibt alles Hinweis",
  keys(focusParts("Barrierefreiheit")) === "",
  keys(focusParts("Barrierefreiheit")),
)
check(
  "die Schreibweise des Nutzers bleibt",
  focusParts("Barrierefreiheit").hint === "Barrierefreiheit",
  focusParts("Barrierefreiheit").hint,
)
check("auch mehrwortig wortgleich", focusParts("mehr Ideen").hint === "mehr Ideen", focusParts("mehr Ideen").hint)
check("ohne Argument kein Filter", keys(focusParts(undefined)) === "")
check("leeres Argument kein Filter", keys(focusParts("   ")) === "")
check('"alle" hebt den Filter auf', keys(focusParts("alle")) === "" && focusParts("alle").hint === "")
check("Bereich plus Zusatz: Filter und Rest-Hinweis", keys(focusParts("Gui Barrierefreiheit")) === "gui")
check(
  "der Rest bleibt als Hinweis",
  focusParts("Gui Barrierefreiheit").hint === "Barrierefreiheit",
  focusParts("Gui Barrierefreiheit").hint,
)
check("Objektform wird durchgereicht", keys(focusParts({ areas: [areaOf("tests")], hint: "x" })) === "tests")

console.log("")
console.log("filterByAreas: nur der gefragte Bereich bleibt")
const mixed = [
  { title: "Neue Auswahlansicht für Projekte", detail: "baut auf der bestehenden Ansicht auf" },
  { title: "Testabdeckung der Auswertung erhöhen", detail: "die Auswertung ist ungetestet" },
  { title: "Client-Bibliothek um Retry erweitern", detail: "der Client wiederholt nichts" },
]
const gui = filterByAreas(mixed, [areaOf("gui")])
check(
  "Oberflächenvorschlag bleibt",
  gui.length === 1 && gui[0].title.startsWith("Neue Auswahlansicht"),
  String(gui.length),
)
check("Testvorschlag fällt weg", !gui.some((item) => item.title.includes("Testabdeckung")))
check("'Client' zählt nicht als cli", filterByAreas([mixed[2]], [areaOf("cli")]).length === 0)
check(
  "'Kommandozeile' zählt als cli",
  filterByAreas([{ title: "Kommandozeile um Export erweitern" }], [areaOf("cli")]).length === 1,
)
check(
  "gesetztes area-Feld genügt",
  filterByAreas([{ area: "gui", title: "Irgendetwas" }], [areaOf("gui")]).length === 1,
)
check(
  "fremdes area-Feld wird verworfen",
  filterByAreas([{ area: "tests", title: "Neue Ansicht" }], [areaOf("gui")]).length === 0,
)
check("ohne Filter bleibt alles", filterByAreas(mixed, []).length === 3)
check(
  "'und' aus Beschriftungen zaehlt nicht",
  !areaWords(areaOf("data")).includes("und"),
  areaWords(areaOf("data")).join(","),
)

console.log("")
console.log("selectAreas: Pflichtbereiche werden nicht aufgezwungen")
const detected = detectAreas(["packages/core/a.ts", "components/Button.tsx", "tests/a.test.ts"])
check("ohne Filter kommen beide Pflichtbereiche", selectAreas(detected, ["packages/core/a.ts"], []).length >= 2)
const onlyGui = selectAreas(detected, ["components/Button.tsx"], ["gui"])
check(
  "mit Filter nur der gefragte Bereich",
  onlyGui.every((area) => area.key === "gui"),
  onlyGui.map((area) => area.key).join(","),
)
check("Architektur wird nicht ergaenzt", !onlyGui.some((area) => area.key === "architecture"))
check(
  "nicht erkannt wird trotzdem gefuehrt",
  selectAreas([], ["a.ts"], ["gui"]).some((area) => area.key === "gui"),
)

console.log("")
console.log("ensureAreaSuggestions + areaFallback")
const guaranteed = ensureAreaSuggestions([], [{ ...areaOf("gui"), samples: ["app/App.tsx"] }], 5)
check(
  "der Pflichtbereich wird ergaenzt",
  guaranteed.length === 1 && guaranteed[0].area === "gui",
  String(guaranteed.length),
)
check("als Erweitern", guaranteed[0]?.detail?.startsWith("Erweitern"))
check("der Beleg steht im Text", guaranteed[0]?.detail?.includes("app/App.tsx"), guaranteed[0]?.detail)
check(
  "ein Bereich ohne Beispiele stuerzt nicht ab",
  (() => {
    try {
      return ensureAreaSuggestions([], [areaOf("gui")], 5).length === 1
    } catch {
      return false
    }
  })(),
)
const fallback = areaFallback({ ...areaOf("tests"), samples: ["tests/a.test.ts"] })
check("Rueckfall nennt den Bereich", fallback.area === "tests")
check("Rueckfall nennt die Datei", fallback.detail.includes("tests/a.test.ts"), fallback.detail)

console.log("")
console.log("buildPrompt: Filter steht im Auftrag")
const base = {
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
const light = (areasText) => buildPrompt(base, areasText)
// Genug Belege, dass die Session 9 Vorschlaege hergibt: der Filter deckelt dann auf 5.
const rich = (areasText) =>
  buildPrompt(
    {
      ...base,
      edited: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      asks: ["a", "b", "c"],
      commands: ["x", "y", "z", "w", "v", "u", "t", "s", "r", "q"],
    },
    areasText,
  )
const guiPrompt = light("Gui")
check("der Filter wird benannt", guiPrompt.includes("Es kommt ausschließlich zu diesen Bereichen"), "")
check("der Bereich steht mit Schluessel drin", guiPrompt.includes("Oberfläche (GUI)") && guiPrompt.includes('"gui"'))
check("das Ausgabeformat verlangt area", guiPrompt.includes('"area":"…"'))
check("das Ausgabeformat nennt den Schluessel", guiPrompt.includes('"gui"'))
check(
  "bei einem Bereich fragt der Auftrag hoechstens fuenf ab",
  rich("Gui").includes("Mehr als 5 werden es nie."),
  rich("Gui").slice(0, 130),
)
check("ohne Filter bleibt die volle Zahl", rich(undefined).includes("Mehr als 9 werden es nie."))
check("Filter ergaenzt nur den gefragten Bereich", guiPrompt.includes('"tests"') === false)
const hintPrompt = light("Barrierefreiheit")
check("reiner Hinweis bleibt Regel 8", hintPrompt.includes("8. Besonderes Augenmerk: Barrierefreiheit"))
check(
  "reiner Hinweis nennt keinen Bereich",
  hintPrompt.includes("Es kommt ausschließlich zu diesen Bereichen") === false,
)
check("ohne Argument kein Filter", light(undefined).includes("Es kommt ausschließlich") === false)
check("ohne Argument kein Hinweis", light(undefined).includes("Besonderes Augenmerk") === false)
check(
  "mehrere Bereiche stehen beide drin",
  (() => {
    const both = light("Gui, Tests")
    return both.includes('"gui"') && both.includes('"tests"')
  })(),
)

console.log("")
console.log("buildProjectPrompt: Filter ersetzt die Pflichtregel")
const project = (areasText) =>
  buildProjectPrompt("/projekt", { text: "PROJEKT", files: ["src/a.ts"], count: 1 }, [], areasText)
const guiProject = project("Gui")
check("der Filter wird benannt", guiProject.includes("ausschließlich Vorschläge zu diesen Bereichen"))
check("die allgemeine Pflichtregel entfaellt", guiProject.includes("Pflichtvorschlag steht") === false)
check("der Auftrag verlangt alle Vorschlaege aus dem Bereich", guiProject.includes("nicht nur der erste"))
const allProject = project(undefined)
check("ohne Filter bleibt die Pflichtregel", allProject.includes("Pflichtvorschlag steht"))
check("ohne Filter kein Bereichsfilter", allProject.includes("ausschließlich Vorschläge zu diesen Bereichen") === false)
check(
  "unbekanntes Argument bleibt Hinweis",
  project("Barrierefreiheit").includes("Besonderes Augenmerk: Barrierefreiheit"),
)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
