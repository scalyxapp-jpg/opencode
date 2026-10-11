// Prüft den Zwischenspeicher des Projektberichts: ein zweiter /nextProject-Lauf
// darf nichts mehr lesen, ein geänderter Baum und eine abgelaufene Frist müssen
// den Bericht erneuern, und der Stand muss sichtbar sein.
// Fährt die echte setup()-Logik gegen einen Fake-Server, rein lokal.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-7-report-${process.pid}.mjs`)
// Zweite Zwischendatei: dieselbe Quelle mit angehängtem Export für die reinen
// Helfer (Abdeckung, Alter, Stand des Berichts).
const AUX = join(tmpdir(), `auto-suggest-7-report-helpers-${process.pid}.mjs`)

writeFileSync(STAGED, readFileSync(SOURCE, "utf8"))
const plugin = (await import(STAGED + "?t=" + Date.now())).default
// Zweiter Import nur zum Prüfen der reinen Helfer (Kopie mit Exportanhängsel).
writeFileSync(AUX, readFileSync(SOURCE, "utf8") + "\nexport { reportCovers, reportAge, reportStatus }\n")
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

const GUI_TITLE = "Neue Ansicht für Profile"
const TESTS_TITLE = "Tests für src/a.ts nachziehen"
const ARCH_TITLE = "Module sauber trennen"

const REPORT = JSON.stringify({
  summary: "Ein Testprojekt mit Oberfläche.",
  suggestions: [
    {
      kind: "Erweitern",
      title: GUI_TITLE,
      detail: "Die Ansichten in components tragen die Bedienung.",
      prompt: "Baue in components/Button.tsx eine zweite Ansicht ein und prüfe sie mit bun test src.",
      area: "gui",
    },
    {
      kind: "Absichern",
      title: TESTS_TITLE,
      detail: "src/a.ts blieb ohne Test.",
      prompt: "Ergänze Tests für src/a.ts und führe bun test src aus.",
      area: "tests",
    },
    {
      kind: "Erweitern",
      title: ARCH_TITLE,
      detail: "Die Ablage zeigt keine Grenze zwischen den Teilen.",
      prompt: "Trenne in src die Bausteine und führe bun test src aus.",
      area: "architecture",
    },
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
  let generations = 0
  let fail = false
  let sequence = 0
  return {
    tree,
    contents,
    forms,
    prompts,
    listCalls,
    readCalls,
    generations: () => generations,
    setFail: (value) => {
      fail = value
    },
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
    generate: () => {
      if (fail) throw new Error("unexpected status: 502")
      generations++
      return { text: REPORT }
    },
  }
}

async function instance(server, storage) {
  const messages = history()
  const client = {
    session: {
      get: async () => ({ location: { directory: "/projekt" } }),
      generate: async () => server.generate(),
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
check("Teilmenge wird abgedeckt", helpers.reportCovers({ scope: ["gui", "tests"] }, ["tests"]) === true)
check("breiterer Wunsch wird nicht abgedeckt", helpers.reportCovers({ scope: ["gui"] }, ["gui", "tests"]) === false)
check("fremder Bereich wird nicht abgedeckt", helpers.reportCovers({ scope: ["gui"] }, ["docs"]) === false)
check("gerade eben", helpers.reportAge(Date.now() - 1000) === "gerade eben")
check("eine Minute", helpers.reportAge(Date.now() - 60_000) === "vor einer Minute")
check("drei Minuten", helpers.reportAge(Date.now() - 180_000) === "vor 3 Minuten")
check("zwei Stunden", helpers.reportAge(Date.now() - 2 * 3600_000) === "vor 2 Stunden")
check(
  "frisch gelesen steht im Stand",
  helpers.reportStatus({ at: Date.now() }, false).startsWith("Projektbericht: neu gelesen"),
  helpers.reportStatus({ at: Date.now() }, false),
)
check(
  "wiederverwendet nennt den Stand",
  helpers.reportStatus({ at: Date.now() - 180_000 }, true).includes("zwischengespeichert") &&
    helpers.reportStatus({ at: Date.now() - 180_000 }, true).includes("vor 3 Minuten"),
  helpers.reportStatus({ at: Date.now() - 180_000 }, true),
)

console.log("")
console.log("erster Lauf liest und legt ab")
const server = makeServer()
const storage = makeStorage()
const window1 = await instance(server, storage)
await window1.ask(undefined)
await sleep(400)

const firstForm = server.pending()[0]
check("ein Formular steht bereit", server.forms.length === 1, String(server.forms.length))
check("eine Generierung", server.generations() === 1, String(server.generations()))
check("der Baum wurde gelesen", server.listCalls.length >= 3, server.listCalls.join(","))
check("Dateien wurden gelesen", server.readCalls.length >= 3, server.readCalls.join(","))
check(
  "das Formular nennt den frischen Stand",
  String(firstForm?.metadata?.message).includes("neu gelesen"),
  String(firstForm?.metadata?.message),
)
check(
  "drei Vorschläge ohne Filter",
  (firstForm?.fields?.[0]?.options ?? []).length === 3,
  String((firstForm?.fields?.[0]?.options ?? []).length),
)

const stored = reportDoc(storage)
check("ein Bericht liegt bereit", (stored.entries ?? []).length === 1, JSON.stringify(stored).slice(0, 120))
const entry = (stored.entries ?? [])[0] ?? {}
check("der Bericht nennt das Verzeichnis", entry.directory === "/projekt", String(entry.directory))
check(
  "der Bericht traegt ein Kennzeichen",
  typeof entry.signature === "string" && entry.signature.includes("components"),
  String(entry.signature),
)
check("der Bericht nennt die Zeit", typeof entry.at === "number")
check(
  "ohne Filter deckt er alles ab",
  Array.isArray(entry.scope) && entry.scope.length === 0,
  JSON.stringify(entry.scope),
)
check(
  "die Übersicht des Modells steht drin",
  entry.summary === "Ein Testprojekt mit Oberfläche.",
  String(entry.summary),
)
check(
  "der Bericht aus analyzeProject steht drin",
  String(entry.analysis?.text).includes("TECHNISCHE EINORDNUNG"),
  String(entry.analysis?.text).slice(0, 60),
)
check(
  "die Baumdateien stehen drin",
  (entry.analysis?.files ?? []).includes("src/a.ts"),
  JSON.stringify(entry.analysis?.files),
)
check("die Vorschläge stehen drin", (entry.suggestions ?? []).length === 3, String((entry.suggestions ?? []).length))

const listsAfterFirst = server.listCalls.length
const readsAfterFirst = server.readCalls.length

console.log("")
console.log("zweiter Lauf, gefiltert: nichts wird gelesen")
await closeForm(server)
await window1.ask("Gui")
await sleep(400)
const guiForm = server.pending()[0]
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
  "die Wurzel steht in dieser einen Prüfung",
  server.listCalls[listsAfterFirst] === ".",
  String(server.listCalls[listsAfterFirst]),
)
check("ein Formular", server.forms.length === 2, String(server.forms.length))
check(
  "nur der gefragte Bereich",
  (guiForm?.fields?.[0]?.options ?? []).map((option) => option.value).join("|") === GUI_TITLE,
  JSON.stringify((guiForm?.fields?.[0]?.options ?? []).map((option) => option.value)),
)
check("der Titel nennt den Bereich", String(guiForm?.title).startsWith("Oberfläche (GUI)"), String(guiForm?.title))
check(
  "der Stand steht im Formular",
  String(guiForm?.metadata?.message).includes("zwischengespeichert"),
  String(guiForm?.metadata?.message),
)
check(
  "und die Übersicht des Berichts",
  String(guiForm?.metadata?.message).includes("Ein Testprojekt mit Oberfläche."),
  String(guiForm?.metadata?.message),
)

console.log("")
console.log("der Auftrag nennt den Stand des Berichts")
server.answer(guiForm.id, [GUI_TITLE])
await sleep(2600)
const task = server.prompts.at(-1)?.text ?? ""
check("der Auftrag wurde abgeschickt", task.length > 0)
check("der Auftrag nennt den Stand", task.includes("Projektbericht: zwischengespeichert"), task.slice(0, 200))
check("der Auftrag nennt das Verzeichnis", task.includes("/projekt"), task.slice(0, 200))
check("das modellgeschriebene Prompt steht drin", task.includes("Baue in components/Button.tsx"), task.slice(0, 300))

console.log("")
console.log("dritter Lauf, gleicher Bereich: wieder nichts zu lesen")
const listsBeforeThird = server.listCalls.length
const readsBeforeThird = server.readCalls.length
await closeForm(server)
await window1.ask("Gui")
await sleep(400)
check("keine neue Generierung", server.generations() === 1, String(server.generations()))
check(
  "keine Datei gelesen",
  server.readCalls.length === readsBeforeThird,
  server.readCalls.slice(readsBeforeThird).join(","),
)
check(
  "nur die Wurzel geprüft",
  server.listCalls.length === listsBeforeThird + 1,
  server.listCalls.slice(listsBeforeThird).join(","),
)

console.log("")
console.log("auch der breite Wunsch kommt aus dem Bericht")
const listsBeforePlain = server.listCalls.length
const readsBeforePlain = server.readCalls.length
await closeForm(server)
await window1.ask(undefined)
await sleep(400)
check("keine neue Generierung", server.generations() === 1, String(server.generations()))
check(
  "keine Datei gelesen",
  server.readCalls.length === readsBeforePlain,
  server.readCalls.slice(readsBeforePlain).join(","),
)
check(
  "nur die Wurzel geprüft",
  server.listCalls.length === listsBeforePlain + 1,
  server.listCalls.slice(listsBeforePlain).join(","),
)
check(
  "alle drei Vorschläge stehen bereit",
  (server.pending()[0]?.fields?.[0]?.options ?? []).length === 3,
  String((server.pending()[0]?.fields?.[0]?.options ?? []).length),
)

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
  server.generations() === beforeTreeChange + 1,
  String(server.generations()),
)
check("die neue Datei wurde gelesen", server.readCalls.includes("tools/build.ts"), server.readCalls.slice(-4).join(","))
await closeForm(server)

console.log("")
console.log("breiterer Wunsch nach einem gefilterten Bericht")
const beforeWide = server.generations()
const filteredReport = reportDoc(storage)
check(
  "der Bericht deckt jetzt nur den Bereich ab",
  JSON.stringify(filteredReport.entries[0]?.scope) === '["gui"]',
  JSON.stringify(filteredReport.entries[0]?.scope),
)
await window1.ask(undefined)
await sleep(600)
check("der breite Wunsch liest neu", server.generations() === beforeWide + 1, String(server.generations()))
const afterWide = reportDoc(storage)
check(
  "der Bericht deckt danach alles ab",
  ((afterWide.entries ?? [])[0]?.scope ?? []).length === 0,
  JSON.stringify((afterWide.entries ?? [])[0]?.scope),
)
check(
  "es bleibt bei einem Bericht je Verzeichnis",
  (afterWide.entries ?? []).length === 1,
  String((afterWide.entries ?? []).length),
)
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
  server.generations() === beforeTtl + 1,
  String(server.generations()),
)
const refreshed = reportDoc(storage)
check(
  "der Bericht ist danach wieder frisch",
  Date.now() - (refreshed.entries[0]?.at ?? 0) < 60_000,
  String(refreshed.entries[0]?.at),
)
check(
  "der Bereich steht im Bericht",
  JSON.stringify(refreshed.entries[0]?.scope) === '["gui"]',
  JSON.stringify(refreshed.entries[0]?.scope),
)
await closeForm(server)

console.log("")
console.log("ohne Bericht und ohne Kennzeichen: es wird gelesen")
const server2 = makeServer()
const storage2 = makeStorage()
const window2 = await instance(server2, storage2)
server2.tree["."] = []
await window2.ask("Gui")
await sleep(400)
check("ohne Baum kein Formular", server2.pending().length === 0, String(server2.pending().length))
check(
  "ohne Baum keine Ablage",
  reportDoc(storage2).entries.length === 0,
  JSON.stringify(reportDoc(storage2)).slice(0, 80),
)
check("ohne Baum keine Generierung", server2.generations() === 0, String(server2.generations()))

console.log("")
console.log("zwei Fenster teilen den Bericht")
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

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
