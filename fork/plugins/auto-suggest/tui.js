/**
 * auto-suggest — schlägt nach abgeschlossenen Schritten nächste Arbeiten vor.
 *
 * Läuft als normales opencode-Plugin (Server meldet features.tui, TUI lädt `tui`).
 * Bewusst ohne JSX und ohne Imports: die Plugin-API nimmt einfache Objekte, und
 * ein Build-Schritt würde die Installation nur erschweren.
 *
 * Die Belege stammen ausschließlich aus den Tool-Aufrufen dieser Session. Gibt
 * es keine, wird nicht gefragt — ein Vorschlag ohne Grundlage wäre geraten.
 */

const EVIDENCE_WINDOW = 40
const MAX_FILES = 12
const MAX_COMMANDS = 8
const MIN_TURNS = 2

const FILE_TOOLS = new Set(["read", "edit", "write", "patch", "glob", "grep"])
const SHELL_TOOLS = new Set(["bash", "shell"])

const clip = (value, max) => (value.length > max ? value.slice(0, max - 1) + "…" : value)

const stringField = (input, keys) => {
  if (!input || typeof input !== "object") return ""
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

/** Sammelt Belege, neueste zuerst — sonst beschreiben Vorschläge den Session-Anfang. */
function collectEvidence(messages) {
  const assistant = (messages ?? []).filter((message) => message.type === "assistant")
  const recent = assistant.slice(-EVIDENCE_WINDOW)

  const files = []
  const commands = []
  const failures = []
  let lastClaim = ""

  const add = (list, value, max) => {
    if (value && !list.includes(value) && list.length < max) list.push(value)
  }

  for (let index = recent.length - 1; index >= 0; index--) {
    const content = recent[index].content ?? []

    if (!lastClaim) {
      const text = content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n\n")
        .trim()
      if (text) lastClaim = clip(text, 400)
    }

    for (const block of content) {
      if (block.type !== "tool") continue
      const state = block.state ?? {}
      const input = state.input
      const target = stringField(input, ["filePath", "path", "pattern", "url"])

      if (FILE_TOOLS.has(block.name)) add(files, target, MAX_FILES)
      if (SHELL_TOOLS.has(block.name)) add(commands, clip(stringField(input, ["command", "cmd"]), 100), MAX_COMMANDS)

      if (state.status === "error" && failures.length < 6) {
        failures.push({
          tool: block.name,
          target: clip(target || stringField(input, ["command"]), 70),
          error: clip(String(state.error?.message ?? "failed"), 140),
        })
      }
    }
  }

  return { turns: recent.length, totalTurns: assistant.length, files, commands, failures, lastClaim }
}

/** Auftrag samt Belegblock. Die Anweisung steht vorne und wird hinten wiederholt. */
function buildPrompt(evidence, focus) {
  const lines = [`Turns in dieser Session: ${evidence.totalTurns}, davon betrachtet: ${evidence.turns}`]
  if (evidence.files.length) lines.push(`Zuletzt angefasste Dateien (neueste zuerst): ${evidence.files.join(", ")}`)
  if (evidence.commands.length)
    lines.push(`Zuletzt ausgeführte Befehle (neueste zuerst): ${evidence.commands.join(" | ")}`)
  if (evidence.failures.length) {
    lines.push("Fehlgeschlagene Aufrufe (neueste zuerst):")
    for (const failure of evidence.failures)
      lines.push(`  - ${failure.tool} auf ${failure.target || "?"}: ${failure.error}`)
  }
  if (evidence.lastClaim) lines.push(`Letzte Aussage, wörtliches Zitat: ${JSON.stringify(evidence.lastClaim)}`)
  if (lines.length === 1) lines.push("Keine abgeschlossenen Arbeitsschritte im Verlauf.")

  return [
    "AUFGABE: Nenne drei bis vier nächste Arbeitsschritte.",
    "Regeln:",
    "1. Jeder Schritt muss sich auf einen Punkt der Belege unten stützen können.",
    "2. Erfinde keine Dateien, Funktionen, Tests oder Probleme, die dort nicht stehen.",
    "3. Wenn die Belege keinen sinnvollen Schritt hergeben, gib ein leeres Array zurück.",
    focus ? `4. Besonderes Augenmerk: ${focus}` : "",
    "",
    "BELEGE (nur diese, keine Annahmen darüber hinaus):",
    lines.join("\n"),
    "",
    'Antworte jetzt ausschließlich mit einem JSON-Array der Form [{"title":"…","detail":"…"}].',
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
            return {
              title: clip(title, 120),
              detail: clip(String(item.detail ?? item.reason ?? item.why ?? "").trim(), 240),
            }
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

    async function ask(sessionID, focus) {
      if (pending || !sessionID) return false

      const messages = data.session.message.list(sessionID) ?? []
      const evidence = collectEvidence(messages)
      const grounded = evidence.files.length + evidence.commands.length + evidence.failures.length > 0
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

        const chosen = await ui.dialog.select({
          title: "Was als Nächstes?",
          placeholder: "Vorschlag filtern",
          options: suggestions.map((suggestion) => ({
            title: suggestion.title,
            description: suggestion.detail || undefined,
            value: suggestion,
            category: "Vorschlag",
          })),
        })
        if (!chosen) return true

        // Externe Plugins haben keinen Zugriff auf den Composer, deshalb wird der
        // Vorschlag direkt abgeschickt statt nur eingefügt.
        await client.session.prompt({ sessionID, text: chosen.title })
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
    // her. Deshalb nur einmal pro Turn und mit kurzer Verzögerung.
    const onIdle = (event) => {
      const sessionID = event?.data?.sessionID ?? currentSession()
      if (!sessionID) return

      const messages = data.session.message.list(sessionID) ?? []
      const last = [...messages].reverse().find((message) => message.type === "assistant")
      if (!last || last.id === answeredTurn) return

      const evidence = collectEvidence(messages)
      if (evidence.turns < MIN_TURNS) return
      if (evidence.files.length + evidence.commands.length + evidence.failures.length === 0) return

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
