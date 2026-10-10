/**
 * auto-suggest — schlägt nach abgeschlossenen Schritten nächste Arbeiten vor.
 *
 * Läuft als normales opencode-Plugin (Server meldet features.tui, TUI lädt `tui`).
 * Bewusst ohne JSX und ohne Imports: die Plugin-API nimmt einfache Objekte, und
 * ein Build-Schritt würde die Installation nur erschweren.
 *
 * Die Belege stammen ausschließlich aus dieser Session. Damit die Vorschläge
 * zum Vorhaben passen, werden nicht nur die Werkzeugaufrufe gelesen, sondern
 * auch die Anfragen des Nutzers, die Unterscheidung zwischen geänderten und nur
 * gelesenen Dateien, der erkannte Arbeitsmodus und die sichtbaren Lücken (etwa:
 * Code geändert, aber kein Test angefasst). Gibt es nichts Belastbares, wird
 * nicht gefragt — ein Vorschlag ohne Grundlage wäre geraten.
 */

const EVIDENCE_WINDOW = 40
const MAX_FILES = 14
const MAX_COMMANDS = 8
const MAX_ASKS = 4
const MIN_TURNS = 2

const FILE_TOOLS = new Set(["read", "edit", "write", "patch", "glob", "grep"])
const WRITE_TOOLS = new Set(["edit", "write", "patch"])
const SHELL_TOOLS = new Set(["bash", "shell"])
const PLAN_TOOLS = new Set(["todowrite", "todoread", "task", "subagent"])

const TEST_HINT =
  /(^|[\\/])(test|tests|spec|specs|__tests__)[\\/]|\.(test|spec)\.[a-z]+$|_test\.go$|^test_.*\.py$|Test(s)?\.(java|kt)$/i
const DOC_HINT = /\.(md|mdx|rst|txt)$/i
const MANIFEST_HINT =
  /(^|[\\/])(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml|composer\.json|Gemfile|CMakeLists\.txt)$/
const CODE_HINT = /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|rb|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|scala|ex|exs|sh)$/i

/** Vier Richtungen. "Fortsetzen" ist die naheliegende, die anderen sind der Mehrwert. */
const KINDS = ["Fortsetzen", "Absichern", "Vertiefen", "Erweitern"]

const clip = (value, max) => (value.length > max ? value.slice(0, max - 1) + "…" : value)

const stringField = (input, keys) => {
  if (!input || typeof input !== "object") return ""
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

/** Textblöcke einer Nachricht — die Form der Blöcke ist je Fassung leicht anders. */
function messageText(content) {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim()
}

/** Gemeinsames Wurzelverzeichnis absoluter Pfade — verrät das Projekt ohne API. */
function commonRoot(files) {
  const absolute = files.filter((file) => file.startsWith("/"))
  if (!absolute.length) return ""
  const split = absolute.map((file) => file.split("/"))
  const first = split[0]
  const shared = []
  for (let index = 0; index < first.length - 1; index++) {
    const part = first[index]
    if (!part) continue
    if (split.every((pieces) => pieces[index] === part)) shared.push(part)
    else break
  }
  return shared.length ? "/" + shared.join("/") : ""
}

/**
 * Sammelt Belege, neueste zuerst — sonst beschreiben Vorschläge den
 * Session-Anfang statt das, woran gerade gearbeitet wird.
 */
function collectEvidence(messages) {
  const all = messages ?? []
  const assistant = all.filter((message) => message.type === "assistant")
  const recent = assistant.slice(-EVIDENCE_WINDOW)

  const asks = []
  const edited = []
  const readOnly = []
  const commands = []
  const failures = []
  const plans = []
  let lastClaim = ""

  const add = (list, value, max) => {
    if (value && !list.includes(value) && list.length < max) list.push(value)
  }

  // Anfragen des Nutzers zuletzt zuerst: sie sagen, worum es eigentlich geht.
  for (let index = all.length - 1; index >= 0 && asks.length < MAX_ASKS; index--) {
    if (all[index].type !== "user") continue
    const text = messageText(all[index].content)
    if (text) asks.push(clip(text.replace(/\s+/g, " "), 200))
  }

  for (let index = recent.length - 1; index >= 0; index--) {
    const content = recent[index].content ?? []

    if (!lastClaim) {
      const text = messageText(content)
      if (text) lastClaim = clip(text, 400)
    }

    for (const block of content) {
      if (!block || block.type !== "tool") continue
      const state = block.state ?? {}
      const input = state.input
      const target = stringField(input, ["filePath", "path", "pattern", "url"])

      if (FILE_TOOLS.has(block.name) && target) {
        // Geändert wiegt schwerer als gelesen: daran hängt, was schon steht.
        if (WRITE_TOOLS.has(block.name)) {
          add(edited, target, MAX_FILES)
          const seen = readOnly.indexOf(target)
          if (seen !== -1) readOnly.splice(seen, 1)
        } else {
          add(readOnly, target, MAX_FILES)
        }
      }
      if (SHELL_TOOLS.has(block.name)) add(commands, clip(stringField(input, ["command", "cmd"]), 100), MAX_COMMANDS)
      if (PLAN_TOOLS.has(block.name) && target) add(plans, clip(target, 90), 6)

      if (state.status === "error" && failures.length < 6) {
        failures.push({
          tool: block.name,
          target: clip(target || stringField(input, ["command"]), 70),
          error: clip(String(state.error?.message ?? "failed"), 140),
        })
      }
    }
  }

  const touched = (list, hint) => list.filter((file) => hint.test(file))
  const code = edited.filter((file) => CODE_HINT.test(file))
  const tests = touched(edited.concat(readOnly), TEST_HINT)
  const docs = touched(edited, DOC_HINT)
  const manifests = touched(edited.concat(readOnly), MANIFEST_HINT)
  const changed = edited.length > 0

  // Der Arbeitsmodus steuert, welche Richtungen sinnvoll sind.
  const joinedCommands = commands.join(" ")
  const mode = failures.length
    ? "Fehlersuche"
    : /\b(test|pytest|jest|vitest|go test|cargo test|gradle.*test|bun test)\b/i.test(joinedCommands)
      ? "Prüfen"
      : /\b(doc|readme|changelog)\b/i.test(edited.join(" "))
        ? "Dokumentieren"
        : changed
          ? "Umsetzen"
          : "Erkunden"

  // Sichtbare Lücken: das ist die Grundlage für "Absichern" und "Vertiefen".
  const signals = []
  if (code.length && !tests.length) signals.push("Code wurde geändert, aber keine Testdatei angefasst")
  if (changed && !commands.length) signals.push("Es wurde geändert, aber kein Befehl ausgeführt — nichts verifiziert")
  if (changed && !docs.length) signals.push("Keine Dokumentation angefasst")
  if (!changed && readOnly.length) signals.push("Bisher nur gelesen, noch nichts geändert")
  if (failures.length) signals.push(`Offene Fehlschläge: ${failures.length}`)
  if (manifests.length) signals.push("Abhängigkeiten oder Build-Dateien waren beteiligt")
  if (plans.length) signals.push("Es gibt einen Plan oder eine Delegation in dieser Session")
  if (!signals.length && changed) signals.push("Änderung steht, nächster Schritt noch offen")

  return {
    turns: recent.length,
    totalTurns: assistant.length,
    asks,
    edited,
    readOnly,
    code,
    tests,
    docs,
    manifests,
    commands,
    failures,
    plans,
    signals,
    mode,
    lastClaim,
    root: commonRoot(edited.concat(readOnly)),
  }
}

/** Auftrag samt Belegblock. Die Anweisung steht vorne und wird hinten wiederholt. */
function buildPrompt(evidence, focus) {
  const lines = [`Erkannter Arbeitsmodus: ${evidence.mode}`]
  lines.push(`Turns in dieser Session: ${evidence.totalTurns}, davon betrachtet: ${evidence.turns}`)
  if (evidence.root) lines.push(`Arbeitsverzeichnis: ${evidence.root}`)

  if (evidence.asks.length) {
    lines.push("Letzte Anfragen des Nutzers (neueste zuerst, wörtlich):")
    for (const ask of evidence.asks) lines.push(`  - ${JSON.stringify(ask)}`)
  }
  if (evidence.edited.length) lines.push(`Geänderte Dateien (neueste zuerst): ${evidence.edited.join(", ")}`)
  if (evidence.readOnly.length) lines.push(`Nur gelesene Dateien (neueste zuerst): ${evidence.readOnly.join(", ")}`)
  if (evidence.tests.length) lines.push(`Tests im Spiel: ${evidence.tests.join(", ")}`)
  if (evidence.docs.length) lines.push(`Dokumentation im Spiel: ${evidence.docs.join(", ")}`)
  if (evidence.manifests.length) lines.push(`Abhängigkeiten oder Build: ${evidence.manifests.join(", ")}`)
  if (evidence.plans.length) lines.push(`Plan oder Delegation: ${evidence.plans.join(", ")}`)
  if (evidence.commands.length) lines.push(`Ausgeführte Befehle (neueste zuerst): ${evidence.commands.join(" | ")}`)
  if (evidence.failures.length) {
    lines.push("Fehlgeschlagene Aufrufe (neueste zuerst):")
    for (const failure of evidence.failures)
      lines.push(`  - ${failure.tool} auf ${failure.target || "?"}: ${failure.error}`)
  }
  if (evidence.signals.length) {
    lines.push("Beobachtete Lücken:")
    for (const signal of evidence.signals) lines.push(`  - ${signal}`)
  }
  if (evidence.lastClaim) lines.push(`Letzte Aussage, wörtliches Zitat: ${JSON.stringify(evidence.lastClaim)}`)
  if (lines.length === 2) lines.push("Kaum verwertbare Arbeitsschritte im Verlauf.")

  return [
    "AUFGABE: Schlage vier bis fünf nächste Arbeiten vor, die aus dieser Session folgen.",
    "Ziel ist nicht, den Faden stumpf fortzusetzen, sondern das Vorhaben voranzubringen:",
    "weitere Fähigkeiten, Verbesserungen, Erweiterungen und Absicherungen.",
    "",
    "Jeder Vorschlag bekommt ein `kind` aus genau dieser Liste:",
    '- "Fortsetzen" — der nächste Schritt derselben Arbeit.',
    '- "Absichern" — Test, Regression, Fehlerfall oder Prüfung dessen, was gerade entstand.',
    '- "Vertiefen" — Qualität des Bestehenden: Struktur, Lesbarkeit, Performance, Sicherheit, Fehlerbehandlung.',
    '- "Erweitern" — eine Fähigkeit, die fachlich auf dem aufbaut, was hier entsteht.',
    "",
    "Regeln:",
    "1. Jeder Vorschlag muss sich auf einen Punkt der Belege stützen können.",
    "2. Erfinde keine Dateien, Funktionen, Tests oder Probleme. Nennt ein Vorschlag eine Datei, muss sie in den Belegen stehen.",
    "3. Beschreibe das Ziel, nicht die Handgriffe.",
    '4. Höchstens zwei Vorschläge mit "Fortsetzen". Die übrigen kommen aus den anderen Gruppen, sofern die Belege das tragen.',
    "5. Wenn die Belege keinen sinnvollen Schritt hergeben, gib ein leeres Array zurück.",
    focus ? `6. Besonderes Augenmerk: ${focus}` : "",
    "",
    "BELEGE (nur diese, keine Annahmen darüber hinaus):",
    lines.join("\n"),
    "",
    'Antworte jetzt ausschließlich mit einem JSON-Array der Form [{"kind":"…","title":"…","detail":"…"}].',
    "`kind` ist einer der vier Werte. `title` ist die Arbeit in wenigen Worten, `detail` begründet sie aus den Belegen.",
    "Kein Codezaun, kein Vorwort, keine Wiederholung dieser Anweisung.",
    "Das erste Zeichen deiner Antwort ist [ und das letzte ].",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

/** Zählt Klammern nur außerhalb von Strings, sonst reißt ein Titel wie "Fix [x]" ab. */
function sliceBalanced(text) {
  const start = text.indexOf("[")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "[") depth++
    if (char === "]") {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Nimmt nur bekannte Richtungen an, sonst bleibt das Feld leer. */
const kindOf = (value) => {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
  return KINDS.find((kind) => kind.toLowerCase() === text) ?? ""
}

/** Detail trägt die Richtung vorne, damit die Liste auf einen Blick streut. */
const withKind = (kind, detail) => clip(kind ? `${kind} · ${detail}` : detail, 240)

/** Drei Stufen, weil Modelle sich nicht zuverlässig an ein Format halten. */
function parseSuggestions(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return []

  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text)
  const candidate = fenced?.[1] ?? sliceBalanced(text)
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {
        const items = parsed
          .map((item) => {
            if (typeof item === "string") return item.trim() ? { title: clip(item.trim(), 120), detail: "" } : undefined
            if (!item || typeof item !== "object") return undefined
            const title = String(item.title ?? item.name ?? item.step ?? "").trim()
            if (!title) return undefined
            const kind = kindOf(item.kind ?? item.lens ?? item.group)
            const detail = String(item.detail ?? item.reason ?? item.why ?? "").trim()
            return { title: clip(title, 120), detail: withKind(kind, detail) }
          })
          .filter(Boolean)
        if (items.length) return items.slice(0, 6)
      }
    } catch {
      /* nächste Stufe */
    }
  }

  const listed = text
    .split("\n")
    .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean)
  if (listed.length >= 2) {
    return listed.slice(0, 6).map((line) => {
      const split = /^(.*?)\s*[—–:]\s+(.*)$/.exec(line)
      return split
        ? { title: clip(split[1].trim(), 120), detail: clip(split[2].trim(), 240) }
        : { title: clip(line, 120), detail: "" }
    })
  }

  return [{ title: clip(text, 120), detail: "" }]
}

/**
 * Wartet auf die Antwort des Formulars.
 *
 * Die Plugin-API meldet kein Ereignis fuer Antworten, deshalb wird der Zustand
 * abgefragt. Das Formular liegt im Verlauf, bis es beantwortet oder abgebrochen
 * wird.
 */
const FORM_POLL_MS = 800
const FORM_TIMEOUT_MS = 10 * 60 * 1000

async function waitForAnswer(client, sessionID, formID) {
  const deadline = Date.now() + FORM_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, FORM_POLL_MS))
    let detail
    try {
      detail = await client.session.form.get({ sessionID, formID })
    } catch {
      return undefined
    }
    const state = detail?.state
    if (!state || state.status === "pending") continue
    if (state.status === "cancelled") return undefined
    const value = state.answer?.next
    const chosen = Array.isArray(value) ? value[0] : value
    return typeof chosen === "string" && chosen.trim() ? chosen : undefined
  }
  return undefined
}

export default {
  id: "auto-suggest",

  async setup(context) {
    const { client, data, ui, keymap } = context
    let pending = false
    let answeredTurn = ""

    const toast = (message, variant) => {
      try {
        ui.toast.show({ message, variant })
      } catch {
        /* Oberfläche nicht bereit */
      }
    }

    // Die Route traegt je nach Fassung `type` oder `name`.
    const currentSession = () => {
      const route = ui.router.current()
      if (!route) return undefined
      const kind = route.type ?? route.name
      return kind === "session" ? (route.sessionID ?? route.params?.sessionID) : undefined
    }

    /** Belege holen und prüfen, ob sie überhaupt etwas hergeben. */
    const readEvidence = (sessionID) => {
      const messages = data.session.message.list(sessionID) ?? []
      const evidence = collectEvidence(messages)
      const grounded =
        evidence.edited.length +
          evidence.readOnly.length +
          evidence.commands.length +
          evidence.failures.length +
          evidence.asks.length >
        0
      return { evidence, grounded }
    }

    async function ask(sessionID, focus) {
      if (pending || !sessionID) return false

      const { evidence, grounded } = readEvidence(sessionID)
      if (!grounded) {
        toast("Keine Belege in dieser Session — kein Vorschlag ohne Grundlage", "warning")
        return false
      }

      pending = true
      try {
        const generated = await client.session.generate({ sessionID, prompt: buildPrompt(evidence, focus) })
        const suggestions = parseSuggestions(generated?.text ?? generated)

        if (!suggestions.length) {
          toast("Die Belege geben keinen nächsten Schritt her", "info")
          return true
        }

        const title = evidence.mode === "Umsetzen" ? "Was als Nächstes? — auch abseits vom Faden" : "Was als Nächstes?"

        // Als Formular statt als Overlay: das rendert inline im Verlauf, genau
        // wie eine Frage des question-Tools. Ein String-Feld MIT options ist der
        // native Einzelauswahl-Typ: nur dann ist `single()` wahr und die
        // Reiterzeile entfaellt, die sonst dasselbe Label doppelt zeigt.
        // `id` ist nur eine optionale Formular-Kennung; Titel und Felder stehen
        // auf oberster Ebene. Anders gelesen scheitert der Aufruf mit
        // "Expected string | null at ["id"]".
        const created = await client.session.form.create({
          sessionID,
          title,
          fields: [
            {
              key: "next",
              type: "string",
              title: "Vorschlag",
              required: true,
              options: suggestions.map((suggestion) => ({
                value: suggestion.title,
                label: suggestion.title,
                description: suggestion.detail || undefined,
              })),
            },
          ],
        })

        const formID = created?.id ?? created?.form?.id
        if (!formID) {
          toast("Formular konnte nicht angelegt werden", "warning")
          return false
        }

        const picked = await waitForAnswer(client, sessionID, formID)
        if (!picked) return true

        // Externe Plugins haben keinen Zugriff auf den Composer, deshalb wird der
        // Vorschlag direkt abgeschickt statt nur eingefügt.
        await client.session.prompt({ sessionID, text: picked })
        return true
      } catch (cause) {
        toast(String(cause?.message ?? cause), "error")
        return false
      } finally {
        pending = false
      }
    }

    // Slash-Kommando und Palette-Eintrag.
    keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.suggest",
          title: "Suggest next steps",
          description: "Fragt das Modell nach dem nächsten Schritt und lässt auswählen",
          group: "Session",
          palette: true,
          slash: { name: "next", arguments: true },
          run(input) {
            const sessionID = currentSession()
            if (!sessionID) {
              toast("Open a session first", "warning")
              return
            }
            void ask(sessionID, typeof input === "string" ? input.trim() || undefined : undefined)
          },
        },
      ],
    }))

    // Automatisch nach einem abgeschlossenen Schritt.
    // Kein "tippt gerade"-Guard möglich: die Plugin-API gibt den Composer nicht
    // her. Deshalb nur einmal pro Turn und erst, wenn wirklich etwas passiert
    // ist — sonst käme der Vorschlag aus dem Nichts.
    const onIdle = (event) => {
      const sessionID = event?.data?.sessionID ?? currentSession()
      if (!sessionID) return

      const messages = data.session.message.list(sessionID) ?? []
      const last = [...messages].reverse().find((message) => message.type === "assistant")
      if (!last || last.id === answeredTurn) return

      const { evidence } = readEvidence(sessionID)
      if (evidence.turns < MIN_TURNS) return
      const didWork = evidence.edited.length + evidence.commands.length + evidence.failures.length > 0
      if (!didWork) return

      answeredTurn = last.id
      void ask(sessionID)
    }

    try {
      data.on("session.idle", onIdle)
    } catch {
      /* Ereignis nicht verfuegbar */
    }
  },
}
