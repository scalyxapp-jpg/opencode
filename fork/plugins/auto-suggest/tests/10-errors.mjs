// Fehlerpfade: jede Schnittstelle darf scheitern, ohne dass der Befehl abstürzt,
// ohne unbehandelte Ablehnung und ohne dass Vorschläge stillschweigend verschwinden.
// Rein lokal, kein Netz.
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE = fileURLToPath(new URL("../tui.js", import.meta.url))
const STAGED = join(tmpdir(), `auto-suggest-10-errors-${process.pid}.mjs`)

writeFileSync(
  STAGED,
  readFileSync(SOURCE, "utf8") +
    "\nexport { clip, collectEvidence, readEvidenceName }\n".replace(", readEvidenceName", ""),
)

// Unbehandelte Ablehnungen sind der eigentliche Fehler, den diese Suite sucht.
const unhandled = []
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)))

const plugin = (await import(STAGED + "?t=" + Date.now())).default
const helpers = await import(STAGED + "?t=" + Date.now())

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
    detail: "Weil die Session zeigt, dass die Steuerung umschaltbar ist.",
    prompt: "Baue umschaltbare Profile in src/plugin.ts ein.",
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
]

function makeStorage({ failUpdate = false } = {}) {
  const files = new Map()
  return {
    files,
    store(key, { initial }) {
      if (!files.has(key)) files.set(key, JSON.parse(JSON.stringify(initial)))
      return [
        files.get(key),
        async (mutation) => {
          if (failUpdate) throw new Error("storage down")
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

function makeServer(options = {}) {
  const forms = []
  const prompts = []
  const toasts = []
  let sequence = 0
  const fail = options.fail ?? {}
  return {
    forms,
    prompts,
    toasts,
    pending: () => forms.filter((form) => form.state.status === "pending").map(({ state, ...info }) => info),
    cancel: (id) => {
      const form = forms.find((item) => item.id === id)
      if (form) form.state = { status: "cancelled" }
    },
    answer: (id, values) => {
      const form = forms.find((item) => item.id === id)
      if (form) form.state = { status: "answered", answer: { next: values } }
    },
    create: (input) => {
      if (fail.create) throw new Error("create kaputt")
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
  }
}

async function instance(server, storage, options = {}) {
  const messages = options.messages ?? history()
  const fail = options.fail ?? {}
  const client = {
    session: {
      get: async () => {
        if (fail.sessionGet) throw new Error("session.get kaputt")
        return { location: { directory: "/projekt" } }
      },
      generate: async () => {
        if (fail.generate) throw new Error("unexpected status: 502")
        return { text: SUGGESTIONS }
      },
      form: {
        list: async () => {
          if (fail.formList) throw new Error("form.list kaputt")
          return server.pending()
        },
        create: async (input) => server.create(input),
        get: async (input) => {
          if (fail.formGet) throw new Error("form.get kaputt")
          return server.forms.find((form) => form.id === input.formID)
        },
        cancel: async (input) => {
          if (fail.formCancel) throw new Error("form.cancel kaputt")
          server.cancel(input.formID)
          return undefined
        },
      },
      prompt: async (input) => {
        if (fail.prompt) throw new Error("prompt kaputt")
        server.prompts.push({ text: input.text, delivery: input.delivery })
      },
    },
    file: {
      list: async () => {
        if (fail.fileList) throw new Error("file.list kaputt")
        return [{ path: "package.json", type: "file" }]
      },
      read: async () => {
        if (fail.fileRead) throw new Error("file.read kaputt")
        return '{"name":"projekt","scripts":{"test":"bun test"}}'
      },
    },
  }
  const data = {
    on: () => () => {},
    session: {
      message: {
        list: () => {
          if (fail.messages) throw new Error("message.list kaputt")
          return messages
        },
      },
    },
  }
  const ui = {
    router: {
      current: () => {
        if (fail.router) throw new Error("router kaputt")
        return { type: "session", sessionID: "ses_1" }
      },
    },
    toast: {
      show: (options) => {
        if (fail.toast) throw new Error("toast kaputt")
        server.toasts.push(options)
      },
    },
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
  await plugin.setup({ client, data, ui, keymap, storage })
  return {
    ask: (input) => command.run(input, undefined),
    askProject: (input) => projectCommand.run(input, undefined),
  }
}

const toasts = (server, needle) => server.toasts.filter((item) => String(item.message ?? "").includes(needle))

console.log("reine Helfer vertragen Nicht-Strings")
check("clip mit undefined", helpers.clip(undefined, 10) === "")
check("clip mit null", helpers.clip(null, 10) === "")
check("clip mit Zahl", helpers.clip(42, 10) === "42")
check("clip kuerzt nur Strings", helpers.clip("abcdefghij", 5) === "abcd…")
check("collectEvidence mit null statt Liste", helpers.collectEvidence(null).edited.length === 0)
check(
  "collectEvidence mit kaputten Eintraegen",
  helpers.collectEvidence([null, undefined, 7, "x", {}]).totalTurns === 0,
  JSON.stringify(helpers.collectEvidence([null, undefined, 7, "x", {}]).totalTurns),
)
check(
  "collectEvidence liest trotzdem den guten Eintrag",
  helpers.collectEvidence([null, ...history()]).edited.includes("src/plugin.ts"),
)
check("collectEvidence mit leerer Liste", helpers.collectEvidence([]).asks.length === 0)

console.log("")
console.log("Der Verlauf ist nicht abrufbar")
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { messages: true } })
  let threw = false
  try {
    window.ask(undefined)
    await sleep(400)
  } catch {
    threw = true
  }
  check("kein Absturz, kein Wurf", !threw)
  check(
    "es wird auf das Projekt ausgewichen",
    toasts(server, "lese stattdessen das Projekt").length === 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
  check("und ein Formular entsteht", server.pending().length === 1, String(server.pending().length))
}

console.log("")
console.log("Die Route ist nicht abrufbar")
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { router: true } })
  let threw = false
  try {
    window.ask(undefined)
    await sleep(300)
  } catch {
    threw = true
  }
  check("kein Absturz", !threw)
  check(
    "mit Hinweis statt Sitzung",
    toasts(server, "Open a session first").length === 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
}

console.log("")
console.log("Formular laesst sich nicht anlegen")
{
  const server = makeServer({ fail: { create: true } })
  const window = await instance(server, makeStorage())
  let threw = false
  try {
    window.ask(undefined)
    await sleep(400)
  } catch {
    threw = true
  }
  check("kein Absturz", !threw)
  check(
    "der Fehler wird gemeldet",
    toasts(server, "create kaputt").length === 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
  check("kein Formular entstanden", server.forms.length === 0)
}

console.log("")
console.log("Das Modell ist nicht erreichbar")
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { generate: true } })
  window.ask(undefined)
  await sleep(400)
  check(
    "es wird gewarnt",
    toasts(server, "Modell nicht erreichbar").length >= 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
  check("und aus den Belegen geantwortet", server.pending().length === 1, String(server.pending().length))
  const options = server.pending()[0]?.fields?.[0]?.options ?? []
  check("mit echten Vorschlägen", options.length > 0, String(options.length))
}

console.log("")
console.log("Abschicken scheitert")
{
  const server = makeServer()
  const window = await instance(server, makeStorage())
  window.ask(undefined)
  await sleep(400)
  const form = server.pending()[0]
  server.answer(form.id, [form.fields[0].options[0].value])
  await sleep(2600)
  check("im Gutfall wird abgeschickt", server.prompts.length === 1, String(server.prompts.length))
}
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { prompt: true } })
  window.ask(undefined)
  await sleep(400)
  const form = server.pending()[0]
  server.answer(form.id, [form.fields[0].options[0].value])
  await sleep(2600)
  check("kein Absturz beim Abschicken", server.prompts.length === 0)
  check(
    "der Fehlschlag wird gemeldet",
    toasts(server, "nicht abgeschickt").length === 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
  const asked = server.toasts.find((t) => String(t.message).includes("nicht abgeschickt"))
  check("und nennt, dass nichts rausging", String(asked?.message).includes("nichts ging raus"), String(asked?.message))
}

console.log("")
console.log("Formularliste und Formularabfrage scheitern")
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { formList: true } })
  window.ask(undefined)
  await sleep(400)
  check("trotzdem ein Formular", server.pending().length === 1, String(server.pending().length))
}
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { formGet: true } })
  window.ask(undefined)
  await sleep(400)
  const form = server.pending()[0]
  server.answer(form.id, [form.fields[0].options[0].value])
  await sleep(2600)
  check("ohne Abfrage kein Absenden", server.prompts.length === 0)
}

console.log("")
console.log("Die Ablage funktioniert nicht")
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: {} })
  window.ask(undefined)
  await sleep(400)
  check("mit Ablage: Formular entsteht", server.pending().length === 1)
}
{
  const storage = makeStorage({ failUpdate: true })
  const server = makeServer()
  const window = await instance(server, storage, {})
  window.ask(undefined)
  await sleep(400)
  check(
    "ohne schreibbare Ablage entsteht trotzdem ein Formular",
    server.pending().length === 1,
    String(server.pending().length),
  )
  const form = server.pending()[0]
  server.answer(form.id, [form.fields[0].options[0].value])
  await sleep(2600)
  check("und der Auftrag geht raus", server.prompts.length === 1, String(server.prompts.length))
}

console.log("")
console.log("Projektmodus: Lesen und Bericht scheitern")
{
  const server = makeServer()
  const window = await instance(server, makeStorage({ failUpdate: true }), { fail: { fileRead: true } })
  window.askProject(undefined)
  await sleep(600)
  check("ohne lesbare Dateien kein Absturz", true)
  check("der Baum traegt trotzdem bis zum Modell", server.pending().length === 1, String(server.pending().length))
}
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { fileList: true } })
  window.askProject(undefined)
  await sleep(600)
  check("ohne Baumliste kein Absturz", true)
  check(
    "mit Hinweis",
    toasts(server, "nichts Lesbares").length === 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
}
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { sessionGet: true, fileRead: true } })
  window.askProject(undefined)
  await sleep(600)
  check("ohne Verzeichnis kein Absturz", true)
  check(
    "mit Hinweis",
    toasts(server, "Kein Projektverzeichnis").length === 1,
    JSON.stringify(server.toasts.map((t) => t.message)),
  )
}

console.log("")
console.log("Die Oberflaeche scheitert beim Melden")
{
  const server = makeServer()
  const window = await instance(server, makeStorage(), { fail: { toast: true, generate: true } })
  let threw = false
  try {
    window.ask(undefined)
    await sleep(400)
  } catch {
    threw = true
  }
  check("kein Absturz, wenn selbst das Melden scheitert", !threw)
  check("die Vorschläge entstehen trotzdem", server.pending().length === 1, String(server.pending().length))
}

console.log("")
console.log("Keine unbehandelte Ablehnung")
await sleep(600)
check("unhandledRejection ist leer", unhandled.length === 0, unhandled.join(" | "))

console.log("")
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
