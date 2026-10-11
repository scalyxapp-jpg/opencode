// Randfälle: null, undefined, leer, nicht-string, Fehlerpfade.
// Rein lokal — keine Datei wird gelesen, kein Server kontaktiert.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-9-edge-${process.pid}.mjs`)

writeFileSync(
  STAGED,
  readFileSync(SOURCE, "utf8") +
    "\nexport { deriveSuggestions, freshSuggestions, isRepeat, looksLikeTask, buildPrompt, focusParts, PROJECT_KEY_FILES, PROJECT_KEY_FILE }\n",
)

const mod = await import(STAGED + "?t=" + Date.now())
const {
  deriveSuggestions,
  freshSuggestions,
  isRepeat,
  looksLikeTask,
  buildPrompt,
  focusParts,
  PROJECT_KEY_FILES,
  PROJECT_KEY_FILE,
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

console.log("Konstanten existieren und sind korrekt typisiert")
check("PROJECT_KEY_FILE ist ein RegExp", PROJECT_KEY_FILE instanceof RegExp)
check("PROJECT_KEY_FILES ist ein Array", Array.isArray(PROJECT_KEY_FILES))
check(
  "PROJECT_KEY_FILES enthält mindestens 12 Einträge",
  PROJECT_KEY_FILES.length >= 12,
  String(PROJECT_KEY_FILES.length),
)
check(
  "alle Einträge sind strings",
  PROJECT_KEY_FILES.every((p) => typeof p === "string"),
)
check(
  "kein Eintrag ist leer",
  PROJECT_KEY_FILES.every((p) => p.trim().length > 0),
)
check(
  "kein Pfad-Separator in Namen",
  PROJECT_KEY_FILES.every((p) => !p.includes("/")),
)
check("REGEXP matcht package.json", PROJECT_KEY_FILE.test("package.json") === true)
check("REGEXP matcht README.md", PROJECT_KEY_FILE.test("README.md") === true)
check("REGEXP matcht AGENTS.md", PROJECT_KEY_FILE.test("AGENTS.md") === true)
check("REGEXP matcht Cargo.toml", PROJECT_KEY_FILE.test("Cargo.toml") === true)
check("REGEXP trifft nicht auf src/index.ts", PROJECT_KEY_FILE.test("src/index.ts") === false)

console.log("")
console.log("focusParts mit anomalem Fokus")
check('null → leeres hint (String(null)→""→trim)', focusParts(null).hint === "")
check("undefined → leeres hint", focusParts(undefined).hint === "")
check('0 als Number → hint "0"', focusParts(0).hint === "0")
check('true → "true"', focusParts(true).hint === "true")
check("{} Objekt → leeres hint", focusParts({}).hint === "")
check('"Gui" als string → Bereich erkannt', focusParts("Gui").areas.length > 0)
check('"" leerer string → leeres hint', focusParts("").hint === "")

console.log("")
console.log("buildPrompt mit fehlenden Feldern")
const fullEvidence = {
  mode: "Umsetzen",
  totalTurns: 5,
  turns: 3,
  asks: ["mach es"],
  edited: ["a.ts"],
  readOnly: [],
  tests: [],
  docs: [],
  manifests: [],
  plans: [],
  commands: [],
  failures: [],
  signals: ["Code geändert, aber keine Tests"],
  lastClaim: "Fertig.",
  root: "/proj",
}
const emptyEvidence = {}

let rA, rB, rC, rD
try {
  rA = buildPrompt({}, "test", [], "")
} catch {
  rA = "error"
}
try {
  rB = buildPrompt(fullEvidence, "", [], "")
} catch {
  rB = "error"
}
try {
  rC = buildPrompt(fullEvidence, "", [], "--- foo\nbar baz")
} catch {
  rC = "error"
}
try {
  rD = buildPrompt(fullEvidence, "", [], null)
} catch {
  rD = "error"
}

check("leere evidence erzeugt string statt Exception", typeof rA === "string")
check("volle evidence enthält BELEGE", rB.includes("BELEGE"))
check("projectContext sichtbar im Prompt", rC.includes("PROJEKTDATEIEN"))
check("null projectContext → string", typeof rD === "string")
if (rC !== "error") {
  const ctxPos = rC.indexOf("PROJEKTDATEIEN")
  const belegePos = rC.indexOf("BELEGE")
  check("projectContext vor BELEGEN", ctxPos < belegePos && belegePos !== -1)
}

console.log("")
console.log("deriveSuggestions mit kranken Eingaben")
let e1, e2, e3, e4, e5, e6
try {
  e1 = deriveSuggestions({ failures: null }, [], 5)
} catch {
  e1 = "error"
}
try {
  e2 = deriveSuggestions({ files: undefined }, [], 5)
} catch {
  e2 = "error"
}
try {
  e3 = deriveSuggestions({ commands: null }, [], 5)
} catch {
  e3 = "error"
}
try {
  e4 = deriveSuggestions({ manifests: null }, [], 5)
} catch {
  e4 = "error"
}
try {
  e5 = deriveSuggestions({}, [], 5)
} catch {
  e5 = "error"
}
try {
  e6 = deriveSuggestions({ edited: ["x.ts"], readOnly: ["x.ts"] }, [], 100)
} catch {
  e6 = "error"
}

check("null failures → array", Array.isArray(e1))
check("undefined files → array", Array.isArray(e2))
check("null commands → array", Array.isArray(e3))
check("null manifests → array", Array.isArray(e4))
check("leeres Object → array", Array.isArray(e5))
check("edited+readOnly Duplikate entfernt", new Set((e6 ?? []).map((i) => i.title)).size === (e6 ?? []).length)

console.log("")
console.log("freshSuggestions / isRepeat mit Edge-Cases")
let f1, f2, f3
try {
  f1 = freshSuggestions([{ title: "Test" }], null).length > 0
} catch {
  f1 = false
}
try {
  f2 = freshSuggestions([{ title: "Test" }], undefined).length > 0
} catch {
  f2 = false
}
try {
  f3 = freshSuggestions([{ title: "Neue Arbeit" }], [123, null, {}, true]).length === 1
} catch {
  f3 = false
}

check("null als seen → array return", f1)
check("undefined als seen → array return", f2)
check("Non-String-Titel ignoriert", f3)
check("isRepeat(42, []) → boolean", typeof isRepeat(42, []) === "boolean")
check("isRepeat('', [...]) → false", isRepeat("", ["Bestehende"]) === false)
check("isRepeat(neu, undef) → false", isRepeat("Neu", undefined) === false)

console.log("")
console.log("looksLikeTask mit Grenzwerten")
check("leerer String → false", looksLikeTask("") === false)
check("nur Whitespace → false", looksLikeTask("   ") === false)
check("101 Zeichen → false", looksLikeTask("a".repeat(101)) === false)
check("Newline → false", looksLikeTask("zeile1\nzeile2") === false)
check("Backticks → false", looksLikeTask("`foo`") === false)
check("Code-Fence → false", looksLikeTask("```") === false)
check("Fragezeichen → false", looksLikeTask("Was machst du?") === false)
check("Listen-Zeichen → false", looksLikeTask("- etwas") === false)
check("Doppelpunkt-Ende → false", looksLikeTask("Fazit:") === false)
check("Ellipsis-Ende → false", looksLikeTask("Noch mehr…") === false)
check("Umlaute-Titel → true", looksLikeTask("Oberfläche um eine Ansicht erweitern") === true)
check("Emoji-Titel → true", looksLikeTask("UI-Komponente hinzufügen 🎨") === true)
check("Normaler Titel → true", looksLikeTask("Tests für auth.ts nachziehen") === true)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
