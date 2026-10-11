delete process.env.NVIDIA_API_KEY // Tests bleiben offline
// Prüft das Formular-Lebenszyklus-Verhalten gegen die echten Funktionen:
// reapForms räumt nur eigene Formulare weg, waitForAnswer liefert Listen und
// lässt bei Zeitablauf kein Formular offen zurück.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-3-forms-${process.pid}.mjs`)

const source = readFileSync(SOURCE, "utf8")
writeFileSync(
  STAGED,
  source +
    "\nexport { keepSoleForm, waitForAnswer, cancelForm, composeTask, taskContext, FORM_KEY, FORM_OWNER, FORM_TIMEOUT_MS }\n",
)

const { keepSoleForm, waitForAnswer, cancelForm, composeTask, taskContext, FORM_KEY, FORM_OWNER, FORM_TIMEOUT_MS } =
  await import(STAGED + "?t=" + Date.now())

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

const own = (id, owner = "self") => ({
  id,
  metadata: { [FORM_OWNER]: owner },
  fields: [{ key: FORM_KEY, type: "multiselect" }],
})
const foreign = (id) => ({ id, fields: [{ key: "authorization", type: "external" }] })

function clientWith({ pending = [], detail, onCancel } = {}) {
  return {
    session: {
      form: {
        list: async () => pending,
        cancel: async (input) => {
          onCancel?.(input.formID)
          return undefined
        },
        get: async () => detail,
      },
    },
  }
}

const cancelled = []
const kept = await keepSoleForm(
  clientWith({ pending: [own("frm_a"), foreign("frm_x"), own("frm_b")], onCancel: (id) => cancelled.push(id) }),
  "ses_1",
  "self",
)
check("keepSoleForm schliesst Doppelgaenger", cancelled.join(",") === "frm_b", cancelled.join(","))
check("keepSoleForm behaelt das aelteste", kept?.id === "frm_a", String(kept?.id))
check("keepSoleForm erkennt das eigene Formular", kept?.owned === true)
check("keepSoleForm laesst fremde Formulare in Ruhe", !cancelled.includes("frm_x"))
check("FORM_KEY ist next", FORM_KEY === "next")

const cancelled2 = []
const kept2 = await keepSoleForm(
  clientWith({ pending: [own("frm_c")], onCancel: (id) => cancelled2.push(id) }),
  "ses_1",
  "self",
)
check(
  "ein einzelnes offenes Formular wird nur gemeldet",
  kept2?.id === "frm_c" && cancelled2.length === 0,
  `${kept2?.id} / ${cancelled2.length}`,
)

const foreignOnly = await keepSoleForm(clientWith({ pending: [foreign("frm_x")] }), "ses_1", "self")
check("ohne eigenes Formular kommt nichts zurueck", foreignOnly === undefined, String(foreignOnly))

const peerForm = await keepSoleForm(clientWith({ pending: [own("frm_peer", "other")] }), "ses_1", "self")
check(
  "Formular eines anderen Fensters wird erkannt",
  peerForm?.id === "frm_peer" && peerForm?.owned === false,
  JSON.stringify(peerForm),
)

const broken = clientWith({})
broken.session.form.list = async () => {
  throw new Error("offline")
}
let threw = false
try {
  const result = await keepSoleForm(broken, "ses_1", "self")
  check("keepSoleForm verschluckt Fehler der Liste", result === undefined, String(result))
} catch {
  threw = true
}
check("keepSoleForm verschluckt Fehler der Liste", !threw)

const answered = clientWith({ detail: { state: { status: "answered", answer: { next: ["A", "B"] } } } })
check("Antwort wird als Liste gelesen", (await waitForAnswer(answered, "ses_1", "frm_1")).join(",") === "A,B")

const single = clientWith({ detail: { state: { status: "answered", answer: { next: "A" } } } })
check("Einzelantwort wird zur Liste", (await waitForAnswer(single, "ses_1", "frm_1")).join(",") === "A")

const messy = clientWith({ detail: { state: { status: "answered", answer: { next: ["A", "  ", 7] } } } })
check("leere und fremde Werte fliegen raus", (await waitForAnswer(messy, "ses_1", "frm_1")).join(",") === "A")

const cancelledForm = clientWith({ detail: { state: { status: "cancelled" } } })
check("Abbruch ergibt leere Auswahl", (await waitForAnswer(cancelledForm, "ses_1", "frm_1")).length === 0)

const failing = clientWith({})
failing.session.form.get = async () => {
  throw new Error("weg")
}
check("Fehler beim Abfragen ergibt leere Auswahl", (await waitForAnswer(failing, "ses_1", "frm_1")).length === 0)

// Zeitablauf: der erste Date.now-Aufruf setzt die Frist, der zweite liegt
// bereits dahinter, also wird die Warteschleife nie betreten.
const realNow = Date.now
let calls = 0
Date.now = () => (++calls === 1 ? 0 : FORM_TIMEOUT_MS + 1)
try {
  const timedOut = []
  const timeoutClient = clientWith({ onCancel: (id) => timedOut.push(id) })
  const result = await waitForAnswer(timeoutClient, "ses_1", "frm_1")
  check("Zeitablauf ergibt leere Auswahl", result.length === 0)
  check("Zeitablauf schliesst das Formular", timedOut.join(",") === "frm_1", timedOut.join(","))
} finally {
  Date.now = realNow
}

let cancelThrew = false
const noCancel = clientWith({})
noCancel.session.form.cancel = async () => {
  throw new Error("nicht erreichbar")
}
try {
  await cancelForm(noCancel, "ses_1", "frm_1")
} catch {
  cancelThrew = true
}
check("cancelForm verschluckt Fehler", !cancelThrew)

// Der Auftrag fuer den Chat: nie die blosse Vorschlagszeile.
const evidence = {
  mode: "Umsetzen",
  root: "/tmp/projekt",
  edited: ["fork/plugins/auto-suggest/tui.js"],
  readOnly: ["packages/tui/src/util/form.ts"],
  commands: ["bun test test/util/form.test.ts"],
  failures: [{ tool: "bash", target: "bun test", error: "1 fail" }],
  asks: ["verbessere die vorschlaege"],
  signals: ["Code wurde geaendert, aber keine Testdatei angefasst"],
}
const written = composeTask(evidence, {
  title: "Profile umschalten",
  detail: "Erweitern · Weil die Steuerung schon umschaltbar ist.",
  prompt: "Baue umschaltbare Profile in src/plugin.ts ein und weise es mit bun test nach.",
})
check("der geschriebene Auftrag wird verwendet", written.includes("Baue umschaltbare Profile in src/plugin.ts ein"))
check("der Auftrag traegt den Titel", written.includes("Profile umschalten"))
check("der Auftrag nennt den Zusammenhang", written.includes("Zusammenhang aus dieser Session"))
check("der Auftrag nennt die geaenderte Datei", written.includes("fork/plugins/auto-suggest/tui.js"))
check("der Auftrag nennt die gelesene Datei", written.includes("packages/tui/src/util/form.ts"))
check("der Auftrag nennt den Fehlschlag", written.includes("bun test: 1 fail"))
check("der Auftrag nennt die Luecke", written.includes("keine Testdatei angefasst"))
check("der Auftrag ist nie nur der Titel", written !== "Profile umschalten")

const withoutPrompt = composeTask(evidence, { title: "Tests nachziehen", detail: "Absichern · fehlt noch" })
check(
  "ohne geschriebenen Auftrag greift die Vorlage",
  withoutPrompt.includes("Verschaffe dir zuerst den noetigen Zusammenhang"),
)
check("die Vorlage nennt das Ziel", withoutPrompt.includes("Tests nachziehen"))
check("auch die Vorlage traegt den Zusammenhang", withoutPrompt.includes("Zusammenhang aus dieser Session"))

check(
  "der Zusammenhang steht zuletzt",
  taskContext(evidence).startsWith("Zusammenhang aus dieser Session (belegt, nicht geraten):"),
)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
