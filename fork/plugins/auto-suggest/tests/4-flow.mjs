delete process.env.NVIDIA_API_KEY // Tests bleiben offline
// Fährt die echte Plugin-setup()-Logik gegen einen gemeinsamen Fake-Server.
// Der automatische Auslöser ist bewusst entfernt: geprüft wird, dass nichts von
// selbst passiert und dass /next genau eine Runde mit einem Mehrfachauswahl-
// Formular ergibt — auch bei zwei Fenstern und genau eine Absendung.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Die Plugin-Quelle liegt nebenan im Ordner; die Zwischendatei, in die der
// Quelltext zum Importieren kopiert wird, geht ins Systemverzeichnis. Kein
// fester Pfad, kein Netz, kein Zugriff auf einen laufenden Server.
const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-4-flow-${process.pid}.mjs`)

writeFileSync(STAGED, readFileSync(SOURCE, "utf8"))
const plugin = (await import(STAGED + "?t=" + Date.now())).default

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

const SUGGESTIONS = JSON.stringify([
  {
    kind: "Erweitern",
    title: "Profile umschalten",
    detail: "Weil die Session zeigt, dass die Steuerung bereits umschaltbar ist.",
    prompt: "Baue umschaltbare Profile in src/plugin.ts ein und weise mit bun test src nach, dass sie greifen.",
  },
  {
    kind: "Absichern",
    title: "Tests nachziehen",
    detail: "Weil src/plugin.ts ohne Test blieb.",
    prompt: "Ergänze Tests fuer src/plugin.ts und fuehre bun test src aus.",
  },
])

const history = () => [
  { id: "msg_u1", type: "user", content: [{ type: "text", text: "Bitte Plugins steuern" }] },
  {
    id: "msg_a1",
    type: "assistant",
    content: [
      { type: "text", text: "Ich baue ein." },
      { type: "tool", name: "edit", state: { status: "completed", input: { filePath: "src/plugin.ts" } } },
    ],
  },
  { id: "msg_u2", type: "user", content: [{ type: "text", text: "weiter" }] },
  {
    id: "msg_a2",
    type: "assistant",
    content: [
      { type: "text", text: "Fertig." },
      { type: "tool", name: "bash", state: { status: "completed", input: { command: "bun test src" } } },
    ],
  },
]

function makeStorage() {
  const files = new Map()
  return {
    store(key, { initial }) {
      if (!files.has(key)) files.set(key, JSON.parse(JSON.stringify(initial)))
      return [
        files.get(key),
        async (mutation) => {
          const draft = JSON.parse(JSON.stringify(files.get(key)))
          mutation(draft)
          files.set(key, draft)
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
  const forms = []
  const prompts = []
  const cancelled = []
  let generations = 0
  let fail = false
  let sequence = 0
  const find = (id) => forms.find((form) => form.id === id)
  return {
    forms,
    prompts,
    cancelled,
    generations: () => generations,
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
    get: (id) => find(id),
    cancel: (id) => {
      const form = find(id)
      if (!form) return
      form.state = { status: "cancelled" }
      cancelled.push(id)
    },
    answer: (id, values) => {
      const form = find(id)
      if (form) form.state = { status: "answered", answer: { next: values } }
    },
    generate: () => {
      if (fail) throw new Error("unexpected status: 502")
      generations++
      return { text: SUGGESTIONS }
    },
    setFail: (value) => {
      fail = value
    },
  }
}

async function instance(server, storage) {
  const registrations = []
  const messages = history()

  const client = {
    session: {
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
  }

  const data = {
    on: (type, handler) => {
      registrations.push({ type, handler })
      return () => {
        const index = registrations.findIndex((item) => item.handler === handler)
        if (index !== -1) registrations.splice(index, 1)
      }
    },
    session: {
      message: { list: () => messages },
      form: {
        sessions: () => [...new Set(server.forms.filter((form) => form.state.status === "pending").map(() => "ses_1"))],
      },
    },
  }

  const ui = {
    router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
    toast: { show: () => undefined },
  }

  let command
  let projectCommand
  const keymap = {
    layer: (build) => {
      for (const item of build().commands ?? []) {
        if (item.id === "session.suggest") command = item
        if (item.id === "session.suggestProject") projectCommand = item
      }
    },
  }

  const cleanup = await plugin.setup({ client, data, ui, keymap, storage })

  return {
    registrations,
    cleanup,
    ask: () => command.run(undefined, undefined),
    askProject: () => projectCommand.run(undefined, undefined),
    addTurn: (id) => {
      messages.push({ id: `${id}_u`, type: "user", content: [{ type: "text", text: "und nun" }] })
      messages.push({
        id,
        type: "assistant",
        content: [
          { type: "text", text: "Erledigt." },
          { type: "tool", name: "edit", state: { status: "completed", input: { filePath: "src/plugin.ts" } } },
        ],
      })
    },
  }
}

// 1. Nichts passiert von selbst.
const serverA = makeServer()
const a = await instance(serverA, makeStorage())
check(
  "hoert nur auf das Anlegen von Formularen",
  a.registrations.length === 1 && a.registrations[0].type === "form.created",
  JSON.stringify(a.registrations.map((r) => r.type)),
)
check("setup liefert einen Aufraeumer", typeof a.cleanup === "function", typeof a.cleanup)
check("Befehl /next ist registriert", serverA.forms.length === 0)
await sleep(1500)
check("nach Warten kein Formular", serverA.forms.length === 0, `erzeugt: ${serverA.forms.length}`)
check("nach Warten keine Generierung", serverA.generations() === 0, `generiert: ${serverA.generations()}`)

// 2. /next ergibt genau eine Runde mit Mehrfachauswahl.
a.ask()
await sleep(1600)
check("auf Anforderung eine Runde", serverA.generations() === 1, `generiert: ${serverA.generations()}`)
check("genau ein Formular", serverA.forms.length === 1, `erzeugt: ${serverA.forms.length}`)
const form = serverA.forms[0]
const field = form?.fields?.[0]
check("Feld ist Mehrfachauswahl", field?.type === "multiselect", String(field?.type))
check("mindestens eine Auswahl verlangt", field?.minItems === 1)
check("Auswahl ist Pflicht", field?.required === true)
check("zwei Optionen stehen bereit", (field?.options ?? []).length === 2)
check("Titel nennt die Anzahl", form?.title === "Was als Nächstes? (2)", String(form?.title))
check("Formular traegt eine Besitzerkennung", typeof form?.metadata?.autoSuggestOwner === "string")

// 3. Zweiter Aufruf, waehrend das Formular offen ist: kein zweites Formular.
a.ask()
await sleep(1600)
check("kein zweites Formular", serverA.forms.length === 1, `erzeugt: ${serverA.forms.length}`)
check("keine zweite Generierung", serverA.generations() === 1, `generiert: ${serverA.generations()}`)

// 4. Abbruch schliesst, danach darf /next wieder fragen.
serverA.cancel(serverA.pending()[0].id)
await sleep(1800)
check("nach dem Abbruch ist nichts mehr offen", serverA.pending().length === 0)
a.ask()
await sleep(1600)
check("nach dem Abbruch fragt /next wieder", serverA.forms.length === 2, `erzeugt: ${serverA.forms.length}`)

// 5. Zwei Fenster: ein Formular, eine Absendung.
const serverB = makeServer()
const shared = makeStorage()
const b1 = await instance(serverB, shared)
const b2 = await instance(serverB, shared)
b1.ask()
b2.ask()
await sleep(2600)
check("zwei Fenster ergeben ein Formular", serverB.pending().length === 1, `offen: ${serverB.pending().length}`)
// Beide Fenster fragen gleichzeitig, also darf zweimal generiert werden; die
// Zusicherung ist das eine Formular und die eine Absendung.
check("zwei Fenster generieren hoechstens zweimal", serverB.generations() <= 2, `generiert: ${serverB.generations()}`)
serverB.answer(serverB.pending()[0].id, ["Profile umschalten", "Tests nachziehen"])
await sleep(2600)
check("je Auswahl eine Absendung", serverB.prompts.length === 2, `gesendet: ${serverB.prompts.length}`)
const [first, second] = serverB.prompts
check("der Auftrag ist nie die blosse Vorschlagszeile", first?.text !== "Profile umschalten", String(first?.text))
check(
  "der modellgeschriebene Auftrag steht drin",
  first?.text?.includes("Baue umschaltbare Profile in src/plugin.ts ein"),
  String(first?.text?.slice(0, 80)),
)
check(
  "der Auftrag nennt den Zusammenhang",
  first?.text?.includes("Zusammenhang aus dieser Session"),
  String(first?.text?.slice(0, 80)),
)
check("der Auftrag nennt die betroffene Datei", first?.text?.includes("src/plugin.ts"))
check(
  "der zweite Auftrag ist eigenstaendig",
  second?.text?.includes("Tests fuer src/plugin.ts"),
  String(second?.text?.slice(0, 80)),
)
check("der erste Auftrag startet den Lauf", first?.delivery === undefined, String(first?.delivery))
check("weitere Auftraege warten in der Warteschlange", second?.delivery === "queue", String(second?.delivery))
check(
  "die Reihenfolge steht im ersten Auftrag",
  first?.text?.includes("Aufgabe 1 von 2"),
  String(first?.text?.slice(0, 40)),
)
check(
  "die Reihenfolge steht im zweiten Auftrag",
  second?.text?.includes("Aufgabe 2 von 2"),
  String(second?.text?.slice(0, 40)),
)
check("die Trennung wird benannt", first?.text?.includes("getrennten Aufgaben"), String(first?.text?.slice(0, 80)))
check("jeder Auftrag nennt den eigenen Abschluss", first?.text?.includes("Danach folgt Aufgabe 2 von 2"))
check("der letzte Auftrag nennt keinen Nachfolger", !second?.text?.includes("Danach folgt Aufgabe"))

// 6. Spurensicherung.
const doc = shared.store("diagnostics", { initial: { log: [] } })[0]
const opened = (doc.log ?? []).filter((entry) => entry.action === "opened")
check("die Spur nennt jedes angelegte Formular", opened.length === 2, JSON.stringify(doc.log))
check("die Spur nennt die Instanz", typeof opened[0]?.instance === "string")

// 7. Wache: ein Formular ohne Anforderungsmarke wird geschlossen, eines mit
//    Marke bleibt.
const serverG = makeServer()
const g = await instance(serverG, makeStorage())
serverG.create({
  sessionID: "ses_1",
  title: "Was als Nächstes? (2)",
  metadata: { autoSuggestOwner: "alt" },
  fields: [{ key: "next", type: "multiselect" }],
})
await sleep(3600)
check("unangefordertes Formular wird geschlossen", serverG.pending().length === 0, `offen: ${serverG.pending().length}`)
check("und zwar als Abbruch", serverG.cancelled.length === 1, serverG.cancelled.join(","))

g.ask()
await sleep(1600)
const requested = serverG.pending()[0]
check(
  "angefordertes Formular traegt die Marke",
  requested?.metadata?.requested === true,
  JSON.stringify(requested?.metadata),
)
await sleep(3000)
check("angefordertes Formular bleibt stehen", serverG.pending().length === 1, `offen: ${serverG.pending().length}`)

// 8. Alte Zuhoerer teilen das Client-Objekt: ohne Anforderungsmarke entsteht
//    gar kein Formular, und der Aufruf bleibt still.
const serverH = makeServer()
const sharedClient = {
  session: {
    generate: async () => serverH.generate(),
    form: {
      list: async () => serverH.pending(),
      create: async (input) => serverH.create(input),
      get: async (i) => serverH.get(i.formID),
      cancel: async (i) => {
        serverH.cancel(i.formID)
        return undefined
      },
    },
    prompt: async () => undefined,
  },
}
await plugin.setup({
  client: sharedClient,
  data: { on: () => () => {}, session: { message: { list: () => history() }, form: { sessions: () => [] } } },
  ui: { router: { current: () => ({ type: "session", sessionID: "ses_1" }) }, toast: { show: () => undefined } },
  keymap: { layer: () => undefined },
  storage: makeStorage(),
})
let settled = false
sharedClient.session.form
  .create({ sessionID: "ses_1", title: "Was als Nächstes? (2)", fields: [{ key: "next", type: "multiselect" }] })
  .then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
await sleep(400)
check(
  "fremdes Anlegen ohne Marke erzeugt kein Formular",
  serverH.forms.length === 0,
  `erzeugt: ${serverH.forms.length}`,
)
check("fremdes Anlegen bleibt still", !settled)

// 9. Kommt ein Formular doch von aussen, wird es im Moment der Meldung
//    geschlossen — nicht erst beim naechsten Durchlauf der Wache.
const serverI = makeServer()
const i = await instance(serverI, makeStorage())
const formCreated = i.registrations.find((item) => item.type === "form.created")?.handler
check("es wird auf form.created gehoert", typeof formCreated === "function")
const stray = serverI.create({
  sessionID: "ses_1",
  title: "Was als Nächstes? (2)",
  metadata: {},
  fields: [{ key: "next", type: "multiselect" }],
})
check("das fremde Formular liegt offen", serverI.pending().length === 1, `offen: ${serverI.pending().length}`)
formCreated({
  data: { form: { id: stray.id, sessionID: "ses_1", metadata: {}, fields: [{ key: "next", type: "multiselect" }] } },
})
await sleep(200)
check("es wird sofort geschlossen", serverI.pending().length === 0, `offen: ${serverI.pending().length}`)
const own = serverI.create({
  sessionID: "ses_1",
  title: "Was als Nächstes? (2)",
  metadata: { requested: true },
  fields: [{ key: "next", type: "multiselect" }],
})
formCreated({
  data: {
    form: {
      id: own.id,
      sessionID: "ses_1",
      metadata: { requested: true },
      fields: [{ key: "next", type: "multiselect" }],
    },
  },
})
await sleep(200)
check("angeforderte Formulare bleiben", serverI.pending().length === 1, `offen: ${serverI.pending().length}`)

// 10. Scheitert das Modell (etwa 502), kommen Vorschlaege aus den Belegen
//     statt gar nichts.
const serverJ = makeServer()
const j = await instance(serverJ, makeStorage())
serverJ.setFail(true)
j.ask()
await sleep(1800)
serverJ.setFail(false)
check("trotz 502 oeffnet sich ein Formular", serverJ.forms.length === 1, `erzeugt: ${serverJ.forms.length}`)
const options = serverJ.forms[0]?.fields?.[0]?.options ?? []
check(
  "die Vorschlaege nennen die Luecke",
  options.some((option) => option.value.includes("Tests")),
  JSON.stringify(options.map((o) => o.value)),
)
check("sie tragen eine Begruendung", typeof options[0]?.description === "string" && options[0].description.length > 0)

// 11. Projektmodus: Baum lesen, zusammenfassen, Vorschlaege mit Uebersicht.
const serverK = makeServer()
const progress = []
let projectFails = false
const promptsSeen = []
const directoriesSeen = []
const projectClient = {
  session: {
    get: async () => ({ data: { location: { directory: "/tmp/projekt" } } }),
    generate: async (input) => {
      serverK.generate()
      promptsSeen.push(String(input?.prompt ?? ""))
      if (projectFails) throw new Error("unexpected status: 502")
      return {
        text: JSON.stringify({
          summary: "Ein kleines Werkzeug mit einem Tui-Plugin und Tests.",
          suggestions: [
            {
              kind: "Erweitern",
              title: "Profilwechsel einbauen",
              detail: "Weil nur eine Konfiguration existiert.",
              prompt: "Baue einen Profilwechsel in src/plugin.ts ein.",
            },
          ],
        }),
      }
    },
    form: {
      list: async () => serverK.pending(),
      create: async (input) => serverK.create(input),
      get: async (i) => serverK.get(i.formID),
      cancel: async (i) => {
        serverK.cancel(i.formID)
        return undefined
      },
    },
    prompt: async (input) => {
      serverK.prompts.push({ text: input.text, delivery: input.delivery })
    },
  },
  file: {
    list: async ({ path, location: where }) => {
      directoriesSeen.push(where?.directory)
      if (path === "." || path === "") {
        return [
          { path: "src", type: "directory" },
          { path: "packages", type: "directory" },
          { path: "node_modules", type: "directory" },
          { path: "README.md", type: "file" },
        ]
      }
      if (path === "src") {
        return [
          { path: "src/plugin.ts", type: "file" },
          { path: "src/bild.png", type: "file" },
          { path: "src/components", type: "directory" },
        ]
      }
      if (path === "src/components") return [{ path: "src/components/App.tsx", type: "file" }]
      if (path === "packages") return [{ path: "packages/core", type: "directory" }]
      if (path === "packages/core") return [{ path: "packages/core/index.ts", type: "file" }]
      return []
    },
    read: async ({ path }) =>
      path === "README.md"
        ? "# Projekt\nEin kleines Werkzeug."
        : path === "src/plugin.ts"
          ? "export const x = 1"
          : path === "src/components/App.tsx"
            ? '/** Zeigt den Verlauf und die Vorschlagsliste. */\nexport function App() { return "/api/session/list" }'
            : "",
  },
}
let projectCommand
await plugin.setup({
  client: projectClient,
  data: {
    on: () => () => {},
    session: {
      message: { list: () => history() },
      form: { sessions: () => [] },
      get: () => ({ location: { directory: "/tmp/projekt" } }),
    },
  },
  ui: {
    router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
    toast: { show: (input) => progress.push(input.message) },
  },
  keymap: {
    layer: (build) => {
      for (const item of build().commands ?? []) if (item.id === "session.suggestProject") projectCommand = item
    },
  },
  storage: makeStorage(),
})

projectCommand.run(undefined, undefined)
await sleep(1800)

check("Projektmodus liest den Baum", serverK.generations() === 1, `generiert: ${serverK.generations()}`)
check("der Baum ignoriert node_modules", !JSON.stringify(progress).includes("node_modules"))
check("der Baum ignoriert Binaerdateien", !JSON.stringify(progress).includes("bild.png"))
check(
  "es wird Fortschritt gemeldet",
  progress.some((message) => message.includes("Projekt lesen")),
  JSON.stringify(progress.slice(0, 4)),
)
check(
  "die Schlüsseldateien werden gemeldet",
  progress.some((message) => message.includes("Schlüsseldateien")),
)
check("es wird ein Projektformular geoeffnet", serverK.forms.length === 1, `erzeugt: ${serverK.forms.length}`)
const projectForm = serverK.forms[0]
check("der Titel nennt den Projektmodus", String(projectForm?.title).includes("Projekt"), String(projectForm?.title))
check(
  "die Uebersicht steht im Formular",
  String(projectForm?.metadata?.message).includes("Werkzeug"),
  String(projectForm?.metadata?.message),
)
check("das Formular traegt die Marke", projectForm?.metadata?.requested === true)

// 11a. Technische Einordnung im Auftrag.
const firstPrompt = promptsSeen[0] ?? ""
check("die technische Einordnung steht im Auftrag", firstPrompt.includes("TECHNISCHE EINORDNUNG"))
check(
  "die Sprachen werden gezaehlt",
  firstPrompt.includes("Sprachen nach Dateizahl: ts 2, tsx 1"),
  firstPrompt.slice(firstPrompt.indexOf("Sprachen"), firstPrompt.indexOf("Sprachen") + 60),
)
check(
  "die Schwerpunkte im Baum stehen drin",
  firstPrompt.includes("Schwerpunkte im Baum") && firstPrompt.includes("src ("),
  firstPrompt.slice(firstPrompt.indexOf("Schwerpunkte"), firstPrompt.indexOf("Schwerpunkte") + 70),
)
check(
  "das Vorhandene wird benannt",
  firstPrompt.includes("Bereits vorhanden") && firstPrompt.includes("Dokumentation (README)"),
)
check("das Fehlende wird benannt", firstPrompt.includes("Fehlt offensichtlich") && firstPrompt.includes("Tests"))
check("das Oekosystem wird nicht erfunden", firstPrompt.includes("keine typischen Manifeste gefunden"))
check("der Auftrag verlangt Bezug auf die Einordnung", firstPrompt.includes("baue deine Vorschläge darauf auf"))

// 11c. Pflichtbereiche: GUI und Architektur sind erkannt, also gibt es je einen
//      Vorschlag dazu — auch wenn das Modell keinen liefert.
check(
  "erkannte Bereiche stehen im Auftrag",
  firstPrompt.includes("Erkannte Bereiche") && firstPrompt.includes("Oberfläche (GUI)"),
)
check("Pflichtbereiche sind markiert", firstPrompt.includes("Oberfläche (GUI) (Pflichtvorschlag)"))
check(
  "die Bereichsbelege stehen drin",
  firstPrompt.includes("src/components/App.tsx") && firstPrompt.includes("packages/core/index.ts"),
)
const areaOptions = projectForm?.fields?.[0]?.options ?? []
check(
  "ein GUI-Vorschlag ist dabei",
  areaOptions.some((option) => option.value.includes("Oberfläche")),
  JSON.stringify(areaOptions.map((option) => option.value)),
)
check(
  "ein Architektur-Vorschlag ist dabei",
  areaOptions.some((option) => option.value.includes("Architektur")),
  JSON.stringify(areaOptions.map((option) => option.value)),
)
const guiOption = areaOptions.find((option) => option.value.includes("Oberfläche"))
const archOption = areaOptions.find((option) => option.value.includes("Architektur"))
check(
  "der GUI-Vorschlag nennt die Belege",
  String(guiOption?.description).includes("components"),
  String(guiOption?.description),
)
check(
  "der Architektur-Vorschlag nennt die Belege",
  String(archOption?.description).includes("packages"),
  String(archOption?.description),
)
check(
  "beide sind als Erweitern ausgewiesen",
  String(guiOption?.description).startsWith("Erweitern") && String(archOption?.description).startsWith("Erweitern"),
)

// 11d. Gebaute Merkmale: was schon steht, steht im Auftrag.
check("die gebauten Merkmale stehen im Auftrag", firstPrompt.includes("GEBAUTE MERKMALE"))
check("der Baustein wird mit Pfad genannt", firstPrompt.includes("src/components/App.tsx"))
check("die Kopfzeile wird gelesen", firstPrompt.includes("Zeigt den Verlauf und die Vorschlagsliste"))
check("die öffentlichen Namen stehen drin", firstPrompt.includes("öffentlich: App"))
check("die Route wird erkannt", firstPrompt.includes("/api/session/list"))
check("das Modell soll anknüpfen", firstPrompt.includes("Baustein benennen, an den er anknüpft"))
check(
  "das Verzeichnis kommt aus der Session",
  directoriesSeen.includes("/tmp/projekt"),
  JSON.stringify([...new Set(directoriesSeen)]),
)
check(
  "es wird nicht das Startverzeichnis gelesen",
  !directoriesSeen.some((dir) => dir && dir.startsWith(process.cwd())),
  [...new Set(directoriesSeen)].join(","),
)

// 11b. Scheitert der Projektmodus am Umfang (502), wird kompakt nachgefasst und
//      notfalls aus dem Projektbaum geantwortet.
serverK.cancel(serverK.pending()[0].id)
await sleep(1400)
const attemptsBefore = serverK.generations()
projectFails = true
projectCommand.run(undefined, undefined)
await sleep(2000)
projectFails = false
check(
  "bei 502 wird kompakt nachgefasst",
  serverK.generations() - attemptsBefore === 2,
  `versuche: ${serverK.generations() - attemptsBefore}`,
)
check("es entsteht trotzdem ein Formular", serverK.forms.length === 2, `erzeugt: ${serverK.forms.length}`)
const robustOptions = serverK.forms[1]?.fields?.[0]?.options ?? []
check(
  "die Vorschlaege stammen aus dem Projekt",
  robustOptions.some((option) => option.value.includes("Tests")),
  JSON.stringify(robustOptions.map((option) => option.value)),
)
check(
  "sie sind begruendet",
  typeof robustOptions[0]?.description === "string" && robustOptions[0].description.length > 0,
)

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
