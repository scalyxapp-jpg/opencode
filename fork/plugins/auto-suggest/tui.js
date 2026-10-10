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
 *
 * Die Anzahl der Vorschläge steht nicht fest: sie folgt der Zahl unabhängiger
 * Anker in den Belegen (s. suggestionBudget), zwischen MIN_SUGGESTIONS und
 * MAX_SUGGESTIONS. Weniger zu liefern ist ausdrücklich erlaubt; auffüllen nicht.
 *
 * Was in den Chat geht, ist nie die Vorschlagszeile selbst. Das Modell schreibt
 * zu jedem Vorschlag einen fertigen Auftrag (`prompt`), und composeTask hängt
 * den belegten Sessionzusammenhang an — sonst fehlt dem Agenten der halbe
 * Kontext oder der Auftrag bleibt unklar. Je Auswahl geht ein eigener Auftrag
 * raus; der erste startet den Lauf, die weiteren warten in der Warteschlange.
 *
 * Die Vorschläge kommen ausschliesslich auf Anforderung: ueber den Befehl
 * `session.suggest` in der Palette oder die Eingabe `/next`. Es oeffnet sich
 * nichts von selbst — auch nicht, wenn der Agent einen Turn abschliesst. Ein
 * Ereignis allein kann nicht entscheiden, ob ein Vorschlag gerade passt, und
 * mehrere Faktoren (mehrere Fenster, Hot-Reload, erneute Ereignisse) haben
 * dafuer gesorgt, dass die Auswahl mehrfach hintereinander aufging.
 *
 * Trotzdem ist das Formular gegen Mehrfachauftreten gesichert: vor dem Anlegen
 * wird geprueft, ob schon eines offen ist (dann wird dieses benutzt),
 * Doppelgaenger werden geschlossen, nur der Ersteller schickt ab, und bei
 * Zeitablauf raeumt waitForAnswer selbst weg. Sonst sammeln sich Formulare an,
 * und ein Abbruch mit `esc` zeigt sofort das naechste gleich aussehende statt zu
 * schliessen.
 */

const EVIDENCE_WINDOW = 40
const MAX_FILES = 14
const MAX_COMMANDS = 8
const MAX_ASKS = 4

// Die Anzahl ist nicht fest. Sie folgt der Belegdichte (s. suggestionBudget),
// aber nie ueber MAX_SUGGESTIONS hinaus und nie unter MIN_SUGGESTIONS.
const MIN_SUGGESTIONS = 3
const MAX_SUGGESTIONS = 10

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

/**
 * Vier Richtungen, nach Erwartung sortiert: Ausbau zuerst, reine Absicherung zuletzt.
 * Die Reihenfolge ist eine Vorgabe an das Modell, nicht nur eine Anzeige.
 */
const KINDS = ["Erweitern", "Vertiefen", "Fortsetzen", "Absichern"]

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
  const budget = suggestionBudget(evidence)
  const band = budget === MIN_SUGGESTIONS ? `${MIN_SUGGESTIONS}` : `${MIN_SUGGESTIONS} bis ${budget}`

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
    lines.push("Beobachtete Lücken (Kontext für Absichern und Vertiefen, keine Pflichtliste):")
    for (const signal of evidence.signals) lines.push(`  - ${signal}`)
  }
  if (evidence.lastClaim) lines.push(`Letzte Aussage, wörtliches Zitat: ${JSON.stringify(evidence.lastClaim)}`)
  if (lines.length === 2) lines.push("Kaum verwertbare Arbeitsschritte im Verlauf.")

  return [
    `AUFGABE: Schlage ${band} nächste Arbeiten vor, die aus dieser Session folgen.`,
    `Mehr als ${budget} werden es nie. Trägt die Session weniger, nimm weniger — auffüllen ist verboten.`,
    "Der Schwerpunkt liegt auf dem Ausbau: neue Fähigkeiten, neue Anwendungsfälle und Ideen,",
    "die auf dem entstandenen Stand aufbauen. Absicherung ist die Ausnahme, nicht die Regel.",
    "",
    "Jeder Vorschlag bekommt ein `kind` aus genau dieser Liste:",
    '- "Erweitern" — eine neue Fähigkeit, ein neuer Anwendungsfall oder eine Idee, die fachlich auf dem aufbaut, was hier entsteht.',
    '- "Vertiefen" — das Bestehende besser machen: Struktur, Lesbarkeit, Performance, Sicherheit, Fehlerbehandlung.',
    '- "Fortsetzen" — der nächste Schritt derselben Arbeit.',
    '- "Absichern" — Test, Regression, Fehlerfall oder Prüfung dessen, was gerade entstand.',
    "",
    "Regeln:",
    "1. Jeder Vorschlag muss sich auf einen Punkt der Belege stützen können.",
    "2. Erfinde keine Dateien, Funktionen, Tests oder Probleme. Nennt ein Vorschlag eine Datei, muss sie in den Belegen stehen.",
    "3. Beschreibe das Ziel, nicht die Handgriffe.",
    "4. Zwei Vorschläge dürfen sich nicht überschneiden. Jeder deckt einen eigenen Punkt ab — Wiederholungen mit anderem Wortlaut zählen nicht als zweiter Vorschlag.",
    '5. Mindestens zwei sind "Erweitern"; ab sieben Vorschlägen mindestens ein Drittel. Sie dürfen über den bisherigen Faden hinausdenken, solange sie an die Belege anknüpfen.',
    '6. Höchstens einer ist "Fortsetzen" und höchstens einer ist "Absichern"; ab acht Vorschlägen höchstens zwei. Alles Übrige ist "Vertiefen".',
    "7. Wenn die Belege keinen sinnvollen Schritt hergeben, gib ein leeres Array zurück.",
    focus ? `8. Besonderes Augenmerk: ${focus}` : "",
    "",
    "BELEGE (nur diese, keine Annahmen darüber hinaus):",
    lines.join("\n"),
    "",
    'Antworte jetzt ausschließlich mit einem JSON-Array der Form [{"kind":"…","title":"…","detail":"…","prompt":"…"}].',
    "`kind` ist einer der vier Werte. `title` ist die Arbeit in wenigen Worten, `detail` begründet sie aus den Belegen.",
    "`prompt` ist der fertige Auftrag, der später wortgleich in den Chat geht — mehrere Sätze, für sich verständlich, ohne Bezug auf dieses Menü.",
    "Er nennt Ziel und Ergebnis, die betroffenen Dateien aus den Belegen, den nötigen Zusammenhang und woran man erkennt, dass die Arbeit fertig ist.",
    "Eine bloße Wiederholung des `title` genügt nicht: wer nur den `prompt` liest, muss den Auftrag vollständig verstehen können.",
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
const withKind = (kind, detail) => {
  if (!kind) return clip(detail, 240)
  if (!detail) return clip(kind, 240)
  return clip(`${kind} · ${detail}`, 240)
}

/**
 * Wie viele Vorschläge diese Session überhaupt trägt.
 *
 * Die Menge folgt der Zahl unabhängiger Anker in den Belegen, nicht der Laune
 * des Modells: eine kurze Session mit zwei Dateien trägt keine zehn
 * Vorschläge, eine mit vielen Spuren (Dateien, Befehle, Anfragen, Lücken)
 * trägt mehr als fünf. Das Ergebnis ist eine Obergrenze, kein Soll — liefert
 * das Modell weniger, bleibt es dabei.
 *
 * Die Stufen sind bewusst grob: feiner wäre eine Genauigkeit, die die Belege
 * nicht hergeben.
 */
function suggestionBudget(evidence) {
  const anchors =
    evidence.edited.length +
    evidence.readOnly.length +
    evidence.commands.length +
    evidence.asks.length +
    evidence.signals.length

  if (anchors <= 5) return MIN_SUGGESTIONS
  if (anchors <= 10) return 5
  if (anchors <= 16) return 7
  return 9
}

/** Doppelte Titel fliegen raus, und nie mehr als das harte Maximum. */
function normalizeSuggestions(items) {
  const seen = new Set()
  const unique = []
  for (const item of items) {
    const title = String(item?.title ?? "").trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...item, title })
    if (unique.length === MAX_SUGGESTIONS) break
  }
  return unique
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
            const kind = kindOf(item.kind ?? item.lens ?? item.group)
            const detail = String(item.detail ?? item.reason ?? item.why ?? "").trim()
            const prompt = String(item.prompt ?? item.task ?? item.auftrag ?? "").trim()
            return { title: clip(title, 120), detail: withKind(kind, detail), prompt: clip(prompt, 1200) }
          })
          .filter(Boolean)
        if (items.length) return normalizeSuggestions(items)
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
    const items = listed.map((line) => {
      const split = /^(.*?)\s*[—–:]\s+(.*)$/.exec(line)
      if (!split) return { title: clip(line, 120), detail: "" }

      // Manche Modelle stellen die Richtung selbst voran ("Erweitern — …").
      // Dann ist der Kopf die Richtung und der Rest der Titel, nicht umgekehrt.
      const kind = kindOf(split[1])
      if (kind) return { title: clip(split[2].trim(), 120), detail: withKind(kind, "") }

      return { title: clip(split[1].trim(), 120), detail: clip(split[2].trim(), 240) }
    })
    const normalized = normalizeSuggestions(items)
    if (normalized.length) return normalized
  }

  return normalizeSuggestions([{ title: clip(text, 120), detail: "" }])
}

/**
 * Macht aus einem Vorschlag einen vollstaendigen Auftrag fuer den Chat.
 *
 * Die Vorschlagszeile allein ist eine Ueberschrift, kein Auftrag: sie nennt
 * weder Ziel noch Zusammenhang, und ohne diesen Zusammenhang fehlt dem Agenten
 * spaeter der halbe Kontext. Deshalb schreibt das Modell zu jedem Vorschlag
 * einen `prompt` (s. buildPrompt), und hier wird zusaetzlich der belegte
 * Sessionzusammenhang angehaengt — auch dann, wenn kein `prompt` vorliegt.
 */
function composeTask(evidence, suggestion, batch) {
  const title = String(suggestion?.title ?? "").trim()
  const detail = String(suggestion?.detail ?? "").trim()
  const written = String(suggestion?.prompt ?? "").trim()

  const body = written
    ? written
    : [
        `Auftrag: ${title || "der genannte Schritt"}`,
        detail,
        "",
        "Verschaffe dir zuerst den noetigen Zusammenhang: sieh dir die unten genannten Dateien an und lies im Code",
        "nach, statt zu raten. Setze die Aufgabe dann vollstaendig um — mit den Tests und der Dokumentation,",
        "die zum Vorhaben gehoeren. Wenn der Auftrag auf einer falschen Annahme beruht, sag das und begruende es.",
      ]
        .filter((line) => line !== "")
        .join("\n")

  const separate = (batch?.total ?? 1) > 1
  const head = [title, separate ? `Aufgabe ${batch.index} von ${batch.total} — eigenständig` : ""]
    .filter(Boolean)
    .join("\n")
  return [head, "", body, "", taskContext(evidence), "", separate ? taskFrame(batch) : ""]
    .filter((part) => part !== "")
    .join("\n")
}

/**
 * Rahmen fuer eine Reihe von Aufgaben.
 *
 * Werden mehrere Vorschlaege gewaehlt, sind das getrennte Arbeiten, nicht eine
 * grosse: ohne diesen Hinweis behandelt der Agent sie als ein Vorhaben und
 * vermischt sie. Deshalb steht in jedem Auftrag, der wievielte er ist und dass
 * die weitere erst danach kommt.
 */
function taskFrame(batch) {
  const next = batch.index < batch.total ? `Danach folgt Aufgabe ${batch.index + 1} von ${batch.total}.` : ""
  return [
    `Rahmen: Dies ist eine von ${batch.total} getrennten Aufgaben. Bearbeite ausschließlich diese eine`,
    "und schließe sie ab, bevor du dich anderem zuwendest. Beginne die weiteren nicht vorab und",
    `vermische sie nicht mit dieser. ${next}`.trim(),
  ].join("\n")
}

/** Der belegte Zusammenhang dieser Session, in kurzer, klarer Form. */
function taskContext(evidence) {
  const lines = ["Zusammenhang aus dieser Session (belegt, nicht geraten):"]
  lines.push(`- Arbeitsmodus: ${evidence.mode}`)
  if (evidence.root) lines.push(`- Arbeitsverzeichnis: ${evidence.root}`)
  if (evidence.edited.length) lines.push(`- Zuletzt geändert: ${evidence.edited.join(", ")}`)
  if (evidence.readOnly.length) lines.push(`- Nur gelesen: ${evidence.readOnly.join(", ")}`)
  if (evidence.commands.length) lines.push(`- Ausgeführte Befehle: ${evidence.commands.join(" | ")}`)
  if (evidence.failures.length) {
    lines.push("Offene Fehlschläge:")
    for (const failure of evidence.failures)
      lines.push(`  - ${failure.tool} auf ${failure.target || "?"}: ${failure.error}`)
  }
  if (evidence.asks.length) lines.push(`- Letzte Anfragen des Nutzers: ${evidence.asks.join(" | ")}`)
  if (evidence.signals.length) lines.push(`- Beobachtete Lücken: ${evidence.signals.join("; ")}`)
  return lines.join("\n")
}

/**
 * Wartet auf die Antwort des Formulars.
 *
 * Die Plugin-API meldet kein Ereignis fuer Antworten, deshalb wird der Zustand
 * abgefragt. Das Formular liegt im Verlauf, bis es beantwortet oder abgebrochen
 * wird.
 *
 * Zurueck kommt immer eine Liste: das Feld ist eine Mehrfachauswahl, damit
 * mehrere Vorschlaege auf einmal uebernommen werden koennen. Ein Abbruch und
 * eine leere Auswahl ergeben dieselbe leere Liste — beides heisst "nichts tun".
 */
const FORM_POLL_MS = 800
const FORM_TIMEOUT_MS = 10 * 60 * 1000

/** Schluessel des Vorschlagsfeldes: daran werden eigene Formulare erkannt. */
const FORM_KEY = "next"

/** Kennung des Erzeugers im Formular-Metadatenfeld (s. keepSoleForm). */
const FORM_OWNER = "autoSuggestOwner"

/**
 * Marke fuer ein ausdruecklich angefordertes Formular.
 *
 * Vorschlaege kommen nur ueber `/next`. Fassungen, die frueher auf Ereignisse
 * gehoert haben, leben in einem laufenden Prozess weiter und legen weiter
 * Formulare an; solche Formulare tragen diese Marke nicht und werden von der
 * Wache (s. sweepUnrequested) wieder geschlossen.
 */
const REQUEST_MARK = "requested"

async function waitForAnswer(client, sessionID, formID) {
  const deadline = Date.now() + FORM_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, FORM_POLL_MS))
    let detail
    try {
      detail = await client.session.form.get({ sessionID, formID })
    } catch {
      return []
    }
    const state = detail?.state
    if (!state || state.status === "pending") continue
    if (state.status === "cancelled") return []
    const value = state.answer?.[FORM_KEY]
    return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string" && item.trim())
  }
  // Laeuft die Zeit ab, ohne dass jemand antwortet, muss das Formular weg.
  // Sonst bleibt es serverseitig offen und steht beim naechsten Mal daneben.
  await cancelForm(client, sessionID, formID)
  return []
}

/**
 * Sorgt dafuer, dass genau ein Vorschlagsformular offen ist.
 *
 * Ein unbeantwortetes Formular bleibt serverseitig offen — und die Oberflaeche
 * zeigt immer das aelteste. Ohne dieses Aufraeumen sammelt sich eines nach dem
 * anderen an: `esc` schliesst dann zwar eines, aber an seiner Stelle erscheint
 * sofort das naechste gleich aussehende. Das wirkt, als liesse sich die Auswahl
 * ueberhaupt nicht schliessen.
 *
 * Liegt schon eines vor, wird es zurueckgegeben und NICHT ersetzt: wuerde jeder
 * Aufruf das vorhandene schliessen und ein neues anlegen, kaeme die Auswahl nie
 * zur Ruhe. Doppelgaenger fliegen raus; es bleibt das aelteste, weil genau das
 * die Oberflaeche zeigt.
 *
 * `owned` sagt, ob das verbleibende Formular von diesem Aufrufer stammt. Nur
 * der Ersteller schickt die Auswahl ab: warten mehrere Fenster auf dasselbe
 * Formular, wuerde sonst dieselbe Auswahl mehrfach gesendet.
 */
async function keepSoleForm(client, sessionID, owner) {
  let pending
  try {
    pending = await client.session.form.list({ sessionID })
  } catch {
    return undefined
  }
  const forms = (pending ?? [])
    .filter((form) => (form?.fields ?? []).some((field) => field?.key === FORM_KEY))
    .sort((left, right) => String(left?.id).localeCompare(String(right?.id)))
  const [keep, ...duplicates] = forms
  if (!keep) return undefined
  await Promise.all(duplicates.map((form) => cancelForm(client, sessionID, form.id)))
  return { id: keep.id, owned: keep.metadata?.[FORM_OWNER] === owner }
}

function cancelForm(client, sessionID, formID) {
  return client.session.form.cancel({ sessionID, formID }).catch(() => undefined)
}

export default {
  id: "auto-suggest",

  async setup(context) {
    const { client, data, ui, keymap, storage } = context

    // Alte Zuhoerer teilen sich dieses Client-Objekt und legen weiter Formulare
    // an. Deshalb wird das Anlegen abgefangen: ohne Anforderungsmarke entsteht
    // gar kein Formular — statt eines, das die Wache erst wieder schliessen
    // muss. Der Aufruf bleibt absichtlich ohne Abschluss, damit der alte
    // Zuhoerer still bleibt statt einen Fehler zu melden.
    const formApi = client?.session?.form
    if (typeof formApi?.create === "function") {
      const createForm = formApi.create.bind(formApi)
      formApi.create = (input) =>
        input?.metadata?.[REQUEST_MARK] === true
          ? createForm(input)
          : new Promise(() => {
              /* absichtlich ohne Abschluss */
            })
    }
    let pending = false

    // Kennzeichnet die Formulare dieses Fensters. Mehrere offene Fenster hoeren
    // dasselbe Ereignis; nur der Erzeuger darf die Auswahl abschicken.
    const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

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
        // Erst nachsehen, ob schon ein Formular offen ist. Dann wird es benutzt
        // statt ein zweites daneben zu legen. Wartet und sendet dort ab, wer es
        // angelegt hat: so kann dieselbe Auswahl nicht zweimal rausgehen.
        const openForm = await keepSoleForm(client, sessionID, INSTANCE_ID)
        if (openForm) {
          if (openForm.owned) await submitSelection(sessionID, openForm, undefined, evidence)
          return true
        }

        const generated = await client.session.generate({ sessionID, prompt: buildPrompt(evidence, focus) })

        // Zweite, belegbasierte Bremse: das Modell darf sich an der Obergrenze
        // nicht vorbeireden. Bei mehr Vorschlägen als die Session trägt, fliegt
        // der Rest hier raus.
        const suggestions = parseSuggestions(generated?.text ?? generated).slice(0, suggestionBudget(evidence))

        if (!suggestions.length) {
          toast("Die Belege geben keinen nächsten Schritt her", "info")
          return true
        }

        const base = evidence.mode === "Umsetzen" ? "Was als Nächstes? — auch abseits vom Faden" : "Was als Nächstes?"
        const title = `${base} (${suggestions.length})`

        // Als Formular statt als Overlay: das rendert inline im Verlauf, genau
        // wie eine Frage des question-Tools. `multiselect` ist der native
        // Mehrfachauswahl-Typ; nur dort wirken minItems/maxItems und nur dort
        // kommt die Antwort als Liste zurueck. `single()` ist damit falsch, die
        // Reiterzeile zeigt deshalb den Titel. Damit das Label trotzdem nicht
        // doppelt erscheint, traegt der Feldkopf einen Hinweis (description)
        // statt des Titels.
        // `id` ist nur eine optionale Formular-Kennung; Titel und Felder stehen
        // auf oberster Ebene. Anders gelesen scheitert der Aufruf mit
        // "Expected string | null at ["id"]".
        const created = await client.session.form.create({
          sessionID,
          title,
          metadata: { [FORM_OWNER]: INSTANCE_ID, [REQUEST_MARK]: true },
          fields: [
            {
              key: FORM_KEY,
              type: "multiselect",
              title: "Vorschläge",
              description: "Enter wählt an, Tab und Enter übernehmen alle gewählten",
              required: true,
              minItems: 1,
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

        note({ action: "opened", sessionID, form: formID, count: suggestions.length })

        // Hat ein zweites Fenster gleichzeitig angelegt, bleibt genau eines
        // stehen — und zwar dasselbe in beiden Fenstern (das aelteste). Wer es
        // nicht selbst angelegt hat, steigt hier aus: das andere Fenster wartet
        // darauf und schickt die Auswahl ab.
        const sole = (await keepSoleForm(client, sessionID, INSTANCE_ID)) ?? { id: formID, owned: true }
        if (!sole.owned) return true
        await submitSelection(sessionID, sole, suggestions, evidence)
        return true
      } catch (cause) {
        toast(String(cause?.message ?? cause), "error")
        return false
      } finally {
        pending = false
      }
    }

    /**
     * Wartet auf die Auswahl und schickt sie ab.
     *
     * Abgeschickt wird nur, wenn das Formular von dieser Instanz stammt
     * (`owned`): mehrere Fenster koennen auf dasselbe Formular warten, und sonst
     * ginge dieselbe Auswahl mehrfach raus. Wer nicht der Ersteller ist, wartet
     * trotzdem — damit ein liegen gebliebenes Formular nach der Wartezeit
     * aufgeraeumt wird.
     *
     * Externe Plugins haben keinen Zugriff auf den Composer, deshalb wird die
     * Auswahl direkt abgeschickt statt nur eingefuegt. Mehrere Vorschlaege gehen
     * als eine Anfrage mit Reihenfolge raus: daraus wird ein Turn statt
     * mehrerer, und der Agent kann die Arbeit selbst aufteilen.
     */
    async function submitSelection(sessionID, form, suggestions, evidence) {
      const picked = await waitForAnswer(client, sessionID, form.id)
      if (!picked.length || !form.owned) return

      // Je ausgewaehltem Vorschlag ein eigener, vollstaendiger Auftrag: nie die
      // blosse Vorschlagszeile, sondern Ziel plus belegter Zusammenhang. Der
      // erste Auftrag startet den Lauf, die weiteren warten in der
      // Warteschlange und kommen als eigene Turns dran.
      const known = new Map((suggestions ?? []).map((suggestion) => [suggestion.title, suggestion]))
      for (const [index, title] of picked.entries()) {
        const suggestion = known.get(title) ?? { title, detail: "", prompt: "" }
        await client.session.prompt({
          sessionID,
          text: composeTask(evidence, suggestion, { index: index + 1, total: picked.length }),
          ...(index === 0 ? {} : { delivery: "queue" }),
        })
      }
      note({ action: "submitted", sessionID, count: picked.length })
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

    // Spurensicherung: was das Plugin bei welcher Runde entschieden hat
    // (begrenzt). Das Serverlog taugt dafuer nicht — es protokolliert nur
    // Fehlantworten, ein erfolgreicher Aufruf steht nicht darin.
    let writeDiagnostics
    try {
      const [, update] = storage.store("diagnostics", { initial: { log: [] } })
      writeDiagnostics = (entry) =>
        update((draft) => {
          draft.log = [...(draft.log ?? []), entry].slice(-60)
        })
    } catch {
      /* ohne Ablage keine Spur */
    }

    const note = (entry) => {
      if (!writeDiagnostics) return
      try {
        void writeDiagnostics({ at: Date.now(), instance: INSTANCE_ID, ...entry }).catch(() => undefined)
      } catch {
        /* Spur ist freiwillig */
      }
    }

    /**
     * Wache gegen Vorschlaege, die niemand angefordert hat.
     *
     * Vorschlaege kommen ausschliesslich ueber `/next`. Aeltere Fassungen hoeren
     * aber weiter auf Ereignisse, solange ihr Prozess laeuft, und legen dabei
     * Formulare an. Die tragen die Anforderungsmarke nicht und werden deshalb
     * wieder geschlossen. Damit ist "nie automatisch" auch dann durchgesetzt,
     * wenn im Prozess noch ein alter Zuhoerer steckt.
     *
     * Ohne offene Formulare kostet die Wache nichts: die Sitzungsliste kommt aus
     * dem lokalen Zustand, erst dann wird der Server gefragt.
     */
    const GUARD_MS = 2000

    const sweepUnrequested = async () => {
      let sessions
      try {
        sessions = data.session.form.sessions()
      } catch {
        return
      }
      await Promise.all(
        (sessions ?? []).map(async (sessionID) => {
          let pending
          try {
            pending = await client.session.form.list({ sessionID })
          } catch {
            return
          }
          const unrequested = (pending ?? []).filter(
            (form) =>
              (form?.fields ?? []).some((field) => field?.key === FORM_KEY) && form.metadata?.[REQUEST_MARK] !== true,
          )
          if (!unrequested.length) return
          note({ action: "sweep", sessionID, forms: unrequested.length })
          await Promise.all(unrequested.map((form) => cancelForm(client, sessionID, form.id)))
        }),
      )
    }

    const guard = setInterval(() => {
      void sweepUnrequested().catch(() => {
        /* Wache ist freiwillig */
      })
    }, GUARD_MS)

    return () => {
      clearInterval(guard)
    }
  },
}
