// Prüft den Zwischenspeicher des Projektberichts UND die Sperre gegen
// Wiederholungen: aus dem Bericht kommt nur, was noch nicht gezeigt wurde; ein
// zweiter Lauf zeigt nichts, was schon dastand. Rein lokal.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-7-report-${process.pid}.mjs`)
// Zweite Zwischendatei: dieselbe Quelle mit angehängtem Export für die reinen
// Helfer (Abdeckung, Alter, Stand des Berichts, Wiederholungsprüfung).
const AUX = join(tmpdir(), `auto-suggest-7-report-helpers-${process.pid}.mjs`)

writeFileSync(STAGED, readFileSync(SOURCE, "utf8"))
const plugin = (await import(STAGED + "?t=" + Date.now())).default
// Zweiter Import nur zum Prüfen der reinen Helfer (Kopie mit Exportanhängsel).
writeFileSync(AUX, readFileSync(SOURCE, "utf8") + "\nexport { reportCovers, reportAge, reportStatus, isRepeat }\n")
const helpers = await import(AUX + "?t=" + Date.now())

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const suggestion = (title, area, kind = "Erweitern") => ({
  kind,
  title,
  detail: `Belegt aus der Ablage (${area}).`,
  prompt: `${title}: umsetzen und mit bun test src prüfen.`,
  area,
})

// Der erste Bericht liefert mehr, als ein Lauf zeigt: der Rest bleibt im
// Zwischenspeicher und kommt beim naechsten Mal als etwas Neues heraus.
const REPORT_A = JSON.stringify({
  summary: "Ein Testprojekt mit Oberfläche.",
  suggestions: [
    suggestion("Neue Ansicht für Profile", "gui"),
    suggestion("Tests für src/a.ts nachziehen", "tests", "Absichern"),
    suggestion("Module sauber trennen", "architecture"),
    suggestion("Bedienung um einen Verlauf erweitern", "gui"),
    suggestion("README um den Start ergänzen", "docs", "Vertiefen"),
    suggestion("Endpunkte für den Export ergänzen", "api"),
    suggestion("Kommandozeile um einen Export-Befehl erweitern", "cli"),
  ],
})

// Der zweite Bericht ist ganz andere Arbeit.
const REPORT_B = JSON.stringify({
  summary: "Ein Testprojekt mit Oberfläche.",
  suggestions: [
    suggestion("Profilwechsel in der Oberfläche anbieten", "gui"),
    suggestion("Tests für src/b.ts nachziehen", "tests", "Absichern"),
    suggestion("Grenze zwischen Anzeige und Daten ziehen", "architecture"),
  ],
})

// Der dritte und alle weiteren wiederholen Bekanntes: dagegen muss die Sperre
// greifen — erst der Nachdruck, dann der letzte Halt.
const REPORT_D = JSON.stringify({
  summary: "Ein Testprojekt mit Oberfläche.",
  suggestions: [
    suggestion("Neue Ansicht für Profile", "gui"),
    suggestion("Tests für src/a.ts nachziehen", "tests", "Absichern"),
    suggestion("Module sauber trennen", "architecture"),
    suggestion("Profilwechsel in der Oberfläche anbieten", "gui"),
  ],
})

const history = () => [
  { id: "msg_u1", type: "user", content: [{ type: "text", text: "Bitte die Oberfläche ausbauen" }] },
  {
    id: "msg_a1",
    type: "assistant",
    content: [
      { type: "text", text: "Ich baue ein." },
      { type: "tool", name: "edit", state: { status: "completed", input: { filePath: "components/Button.tsx" } } },
      { type: "tool", name: "bash", state: { status: "completed", input: { command: "bun test src" } } },
    ],
  },
]

function makeStorage() {
  const files = new Map()
  return {
    files,
    store(key, { initial }) {
      if (!files.has(key)) files.set(key, JSON.parse(JSON.stringify(initial)))
      // Wie der echte Store: dasselbe Objekt bleibt bestehen und wird an Ort
      // und Stelle geändert. Eine Kopie würde die Referenz des Plugins veralten
      // lassen — dann fände es seinen eigenen Bericht nie wieder.
      return [
        files.get(key),
        async (mutation) => {
          mutation(files.get(key))
        },
      ]
    },
    memory(key, { initial }) {
      if (!files.has(key)) files.set(key, JSON.parse(JSON.stringify(initial)))
      return [files.get(key), (mutation) => mutation(files.get(key))]
    },
  }
}

function makeServer() {
  const tree = {
    ".": [
      { path: "components/", type: "directory" },
      { path: "src/", type: "directory" },
      { path: "package.json", type: "file" },
    ],
    components: [{ path: "Button.tsx", type: "file" }],
    src: [
      { path: "a.ts", type: "file" },
      { path: "b.ts", type: "file" },
    ],
  }
  const contents = {
    "package.json": '{"name":"projekt","scripts":{"test":"bun test src"}}',
    "components/Button.tsx": "export function Button() {\n  return null\n}\n",
    "src/a.ts": "export function loadProfile(name) {\n  return { name }\n}\n",
    "src/b.ts": "export function saveProfile(profile) {\n  return profile\n}\n",
  }
  const forms = []
  const prompts = []
  const listCalls = []
  const readCalls = []
  const modelPrompts = []
  const reports = [REPORT_A, REPORT_B, REPORT_D]
  let generations = 0
  let sequence = 0
  return {
    tree,
    contents,
    forms,
    prompts,
    listCalls,
    readCalls,
    modelPrompts,
    generations: () => generations,
    /** Alle je gezeigten Optionen, über alle Formulare hinweg. */
    shown: () => forms.flatMap((form) => (form.fields?.[0]?.options ?? []).map((option) => option.value)),
    pending: () => forms.filter((form) => form.state.status === "pending").map(({ state, ...info }) => info),
    create: (input) => {
      const id = `frm_${String(++sequence).padStart(3, "0")}`
      forms.push({
        id,
        sessionID: input.sessionID,
        title: input.title,
        metadata: input.metadata,
        fields: input.fields,
        state: { status: "pending" },
      })
      return { id }
    },
    get: (id) => forms.find((form) => form.id === id),
    cancel: (id) => {
      const form = forms.find((item) => item.id === id)
      if (form) form.state = { status: "cancelled" }
    },
    answer: (id, values) => {
      const form = forms.find((item) => item.id === id)
      if (form) form.state = { status: "answered", answer: { next: values } }
    },
    generate: (prompt) => {
      modelPrompts.push(prompt)
      const text = reports[Math.min(generations, reports.length - 1)]
      generations++
      return { text }
    },
  }
}

async function instance(server, storage) {
  const messages = history()
  const client = {
    session: {
      get: async () => ({ location: { directory: "/projekt" } }),
      generate: async (input) => server.generate(input?.prompt),
      form: {
        list: async () => server.pending(),
        create: async (input) => server.create(input),
        get: async (input) => server.get(input.formID),
        cancel: async (input) => {
          server.cancel(input.formID)
          return undefined
        },
      },
      prompt: async (input) => {
        server.prompts.push({ text: input.text, delivery: input.delivery })
      },
    },
    file: {
      list: async ({ path }) => {
        server.listCalls.push(path ?? ".")
        return server.tree[path ?? "."] ?? []
      },
      read: async ({ path }) => {
        server.readCalls.push(path)
        return server.contents[path] ?? ""
      },
    },
  }
  const data = {
    on: () => () => {},
    session: { message: { list: () => messages } },
  }
  const ui = {
    router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
    toast: { show: () => undefined },
  }
  let command
  const keymap = {
    layer: (build) => {
      for (const item of build().commands ?? []) if (item.id === "session.suggestProject") command = item
    },
  }
  await plugin.setup({ client, data, ui, keymap, storage })
  return { ask: (input) => command.run(input, undefined) }
}

const reportDoc = (storage) => storage.files.get("project-report") ?? { entries: [] }
const askedDoc = (storage) => storage.files.get("asked") ?? { entries: [] }
const closeForm = async (server) => {
  const open = server.pending()[0]
  if (open) server.cancel(open.id)
  // Der Plugin-Durchlauf merkt den Abbruch erst beim naechsten Abfragen (800 ms).
  await sleep(1700)
}

console.log("reine Helfer")
check("ungefiltert deckt ungefiltert ab", helpers.reportCovers({ scope: [] }, []) === true)
check("ungefiltert deckt auch einen gefilterten Wunsch ab", helpers.reportCovers({ scope: [] }, ["gui"]) === true)
check("gefiltert deckt den breiten Wunsch nicht ab", helpers.reportCovers({ scope: ["gui"] }, []) === false)
check("gleicher Bereich wird abgedeckt", helpers.reportCovers({ scope: ["gui"] }, ["gui"]) === true)
check("breiterer Wunsch wird nicht abgedeckt", helpers.reportCovers({ scope: ["gui"] }, ["gui", "tests"]) === false)
check("gerade eben", helpers.reportAge(Date.now() - 1000) === "gerade eben")
check("drei Minuten", helpers.reportAge(Date.now() - 180_000) === "vor 3 Minuten")
check(
  "wiederverwendet nennt den Stand",
  helpers.reportStatus({ at: Date.now() - 180_000 }, true).includes("zwischengespeichert"),
  helpers.reportStatus({ at: Date.now() - 180_000 }, true),
)
check(
  "frisch gelesen steht im Stand",
  helpers.reportStatus({ at: Date.now() }, false).startsWith("Projektbericht: neu gelesen"),
)

console.log("")
console.log("erster Lauf liest, legt ab und merkt sich das Gezeigte")
const server = makeServer()
const storage = makeStorage()
const window1 = await instance(server, storage)
await window1.ask(undefined)
await sleep(400)

const firstForm = server.pending()[0]
const firstShown = (firstForm?.fields?.[0]?.options ?? []).map((option) => option.value)
check("ein Formular steht bereit", server.forms.length === 1, String(server.forms.length))
check("eine Generierung", server.generations() === 1, String(server.generations()))
check("der Baum wurde gelesen", server.listCalls.length >= 3, server.listCalls.join(","))
check("das Formular nennt den frischen Stand", String(firstForm?.metadata?.message).includes("neu gelesen"))
check("der Lauf zeigt drei Vorschläge", firstShown.length === 3, JSON.stringify(firstShown))

const stored = reportDoc(storage)
const entry = (stored.entries ?? [])[0] ?? {}
check("ein Bericht liegt bereit", (stored.entries ?? []).length === 1)
check("der Bericht nennt das Verzeichnis", entry.directory === "/projekt", String(entry.directory))
check(
  "der Bericht traegt ein Kennzeichen",
  typeof entry.signature === "string" && entry.signature.includes("components"),
)
check("der Bericht deckt alles ab", (entry.scope ?? []).length === 0)
check(
  "der Bericht haelt mehr, als gezeigt wurde",
  (entry.suggestions ?? []).length === 7,
  String((entry.suggestions ?? []).length),
)
check("die Übersicht des Modells steht drin", entry.summary === "Ein Testprojekt mit Oberfläche.")
check("der Bericht aus analyzeProject steht drin", String(entry.analysis?.text).includes("TECHNISCHE EINORDNUNG"))
check("die Vorschläge stehen im Bericht", (entry.suggestions ?? []).length === 7)

const askedEntries = askedDoc(storage).entries ?? []
const sessionEntry = askedEntries.find((item) => item?.key === "session:ses_1")
const projectEntry = askedEntries.find((item) => item?.key === "project:/projekt")
check("das Gezeigte wird je Sitzung gemerkt", (sessionEntry?.titles ?? []).length === 3, JSON.stringify(sessionEntry))
check("das Gezeigte wird je Projekt gemerkt", (projectEntry?.titles ?? []).length === 3, JSON.stringify(projectEntry))
check(
  "und zwar die gezeigten Titel",
  (sessionEntry?.titles ?? []).join("|") === firstShown.join("|"),
  JSON.stringify(sessionEntry?.titles),
)

const listsAfterFirst = server.listCalls.length
const readsAfterFirst = server.readCalls.length

console.log("")
console.log("zweiter Lauf, gefiltert: der Bericht hat noch etwas Neues")
await closeForm(server)
await window1.ask("Gui")
await sleep(400)
const guiForm = server.pending()[0]
const guiShown = (guiForm?.fields?.[0]?.options ?? []).map((option) => option.value)
check("keine neue Generierung", server.generations() === 1, String(server.generations()))
check(
  "keine Datei erneut gelesen",
  server.readCalls.length === readsAfterFirst,
  server.readCalls.slice(readsAfterFirst).join(","),
)
check(
  "nur die Wurzel geprüft",
  server.listCalls.length === listsAfterFirst + 1,
  server.listCalls.slice(listsAfterFirst).join(","),
)
check(
  "nur der gefragte Bereich",
  guiShown.join("|") === "Bedienung um einen Verlauf erweitern",
  JSON.stringify(guiShown),
)
check("nichts davon stand schon da", !guiShown.some((title) => firstShown.includes(title)), JSON.stringify(guiShown))
check("der Titel nennt den Bereich", String(guiForm?.title).startsWith("Oberfläche (GUI)"), String(guiForm?.title))
check("der Stand steht im Formular", String(guiForm?.metadata?.message).includes("zwischengespeichert"))
check("und die Übersicht des Berichts", String(guiForm?.metadata?.message).includes("Ein Testprojekt mit Oberfläche."))

console.log("")
console.log("der Auftrag nennt den Stand des Berichts")
server.answer(guiForm.id, [guiShown[0]])
await sleep(2600)
const task = server.prompts.at(-1)?.text ?? ""
check("der Auftrag wurde abgeschickt", task.length > 0)
check("der Auftrag nennt den Stand", task.includes("Projektbericht: zwischengespeichert"), task.slice(0, 200))
check("der Auftrag nennt das Verzeichnis", task.includes("/projekt"), task.slice(0, 200))

console.log("")
console.log("dritter Lauf, gefiltert: der Bericht ist für diesen Bereich abgegrast")
const beforeThird = server.generations()
await closeForm(server)
await window1.ask("Gui")
await sleep(600)
const thirdForm = server.pending()[0]
const thirdShown = (thirdForm?.fields?.[0]?.options ?? []).map((option) => option.value)
check("jetzt wird wieder generiert", server.generations() === beforeThird + 1, String(server.generations()))
check(
  "der Baum wurde wieder gelesen",
  server.listCalls.length > listsAfterFirst + 1,
  server.listCalls.slice(listsAfterFirst).join(","),
)
check(
  "das Modell bekommt die Liste des Schon-gefragt",
  server.modelPrompts.at(-1)?.includes("BEREITS VORGESCHLAGEN"),
  String(server.modelPrompts.at(-1)?.slice(0, 80)),
)
check(
  "und darin stehen die alten Titel",
  server.modelPrompts.at(-1)?.includes("Bedienung um einen Verlauf erweitern"),
  "",
)
check(
  "der neue Lauf zeigt nur Neues",
  thirdShown.every((title) => !firstShown.includes(title) && !guiShown.includes(title)),
  JSON.stringify(thirdShown),
)
check(
  "und nur den gefragten Bereich",
  thirdShown.every((title) => title.includes("Oberfläche") || title.includes("Profilwechsel")),
  JSON.stringify(thirdShown),
)

console.log("")
console.log("vierter Lauf: das Modell wiederholt sich — die Sperre greift")
const beforeFourth = server.generations()
await closeForm(server)
await window1.ask("Gui")
await sleep(700)
const fourthForm = server.pending()[0]
const fourthShown = (fourthForm?.fields?.[0]?.options ?? []).map((option) => option.value)
check("es wurde nachgefragt", server.generations() >= beforeFourth + 2, String(server.generations()))
check(
  "der Nachdruck steht im zweiten Auftrag",
  server.modelPrompts.at(-1)?.includes("ACHTUNG"),
  String(server.modelPrompts.at(-1)?.slice(-120)),
)
check(
  "es kommt trotzdem ein Formular",
  (fourthForm?.fields?.[0]?.options ?? []).length > 0,
  JSON.stringify(fourthShown),
)
check(
  "kein Titel wiederholt sich",
  fourthShown.every((title) => !firstShown.includes(title) && !guiShown.includes(title) && !thirdShown.includes(title)),
  JSON.stringify(fourthShown),
)

console.log("")
console.log("über alle Läufe hinweg wiederholt sich nichts")
const everShown = server.shown()
const pairs = []
for (let i = 0; i < everShown.length; i++) {
  for (let j = i + 1; j < everShown.length; j++) {
    if (helpers.isRepeat(everShown[i], [everShown[j]])) pairs.push(`${everShown[i]} == ${everShown[j]}`)
  }
}
check("kein Paar ist dieselbe Arbeit", pairs.length === 0, pairs.join(" | "))
check("und es waren überhaupt mehrere", everShown.length >= 6, String(everShown.length))

console.log("")
console.log("geänderter Baum: der Bericht wird erneuert")
await closeForm(server)
const beforeTreeChange = server.generations()
server.tree["."] = [...server.tree["."], { path: "tools/", type: "directory" }]
server.tree.tools = [{ path: "build.ts", type: "file" }]
server.contents["tools/build.ts"] = "export function build() {\n  return 1\n}\n"
await window1.ask("Gui")
await sleep(600)
check(
  "der geänderte Baum erzwingt ein neues Lesen",
  server.generations() >= beforeTreeChange + 1,
  String(server.generations()),
)
check("die neue Datei wurde gelesen", server.readCalls.includes("tools/build.ts"), server.readCalls.slice(-4).join(","))
await closeForm(server)

console.log("")
console.log("abgelaufene Frist: der Bericht wird erneuert")
const beforeTtl = server.generations()
const expired = reportDoc(storage)
expired.entries[0].at = Date.now() - 6 * 60 * 1000
await window1.ask("Gui")
await sleep(600)
check(
  "die abgelaufene Frist erzwingt ein neues Lesen",
  server.generations() >= beforeTtl + 1,
  String(server.generations()),
)
const refreshed = reportDoc(storage)
check(
  "der Bericht ist danach wieder frisch",
  Date.now() - (refreshed.entries[0]?.at ?? 0) < 60_000,
  String(refreshed.entries[0]?.at),
)
await closeForm(server)

console.log("")
console.log("ohne Baum: es wird gelesen, aber nichts abgelegt")
const server2 = makeServer()
const storage2 = makeStorage()
const window2 = await instance(server2, storage2)
server2.tree["."] = []
await window2.ask("Gui")
await sleep(400)
check("ohne Baum kein Formular", server2.pending().length === 0, String(server2.pending().length))
check("ohne Baum keine Ablage", reportDoc(storage2).entries.length === 0)
check("ohne Baum keine Generierung", server2.generations() === 0, String(server2.generations()))

console.log("")
console.log("zwei Fenster teilen Bericht und Sperre")
const server3 = makeServer()
const storage3 = makeStorage()
const w1 = await instance(server3, storage3)
const w2 = await instance(server3, storage3)
await w1.ask(undefined)
await sleep(500)
await closeForm(server3)
const beforeSecond = server3.generations()
await w2.ask("Gui")
await sleep(500)
const sharedShown = server3.pending()[0]?.fields?.[0]?.options?.map((option) => option.value) ?? []
check(
  "das zweite Fenster nutzt den Bericht des ersten",
  server3.generations() === beforeSecond,
  String(server3.generations()),
)
check(
  "das zweite Fenster liest keine Dateien",
  server3.readCalls.filter((path) => path === "src/a.ts").length === 1,
  String(server3.readCalls.filter((path) => path === "src/a.ts").length),
)
check(
  "und zeigt nichts, was schon dastand",
  sharedShown.every((title) => !server3.shown().slice(0, 3).includes(title)),
  JSON.stringify(sharedShown),
)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
