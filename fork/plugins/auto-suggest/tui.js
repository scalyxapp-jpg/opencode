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
    'Jeder Vorschlag ist technische Arbeit am Code oder am Projekt: bauen, umbauen, prüfen, verstehen. Rein Organisatorisches ist kein Vorschlag — kein "git commit", kein "push", kein Release, kein Changelog, kein Ticket, kein Termin.',
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
            const area = String(item.area ?? item.bereich ?? "")
              .trim()
              .toLowerCase()
            return {
              title: clip(title, 120),
              detail: withKind(kind, detail),
              prompt: clip(prompt, 1200),
              ...(area ? { area } : {}),
            }
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
function composeTask(evidence, suggestion, batch, extra) {
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
  return [head, "", body, "", taskContext(evidence, extra), "", separate ? taskFrame(batch) : ""]
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
function taskContext(evidence, extra) {
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
  for (const line of extra ?? []) lines.push(`- ${line}`)
  return lines.join("\n")
}

/**
 * Rein organisatorische Vorschlaege fliegen raus.
 *
 * Vorschlaege sollen technische Arbeit am Code oder am Projekt sein. Ein
 * "git commit und push" ist keine Arbeit am Vorhaben, sondern Verwaltung.
 */
const ADMIN_HINT =
  /\b(git|commit|committen|push|pushen|pull[- ]?request|merge[- ]?request|mergen|rebase|branch(es)?|branchen|release|released|veröffentlichen|publish|semver|version bump|versionsnummer|changelog|backup|sicherung anlegen|ticket|issue anlegen|jira|board|meeting|termin|protokoll|abnahme|freigabe|statusbericht|einreichen|abstimmen|besprechen)\b/i

function technicalOnly(suggestions, evidence) {
  const kept = suggestions.filter(
    (suggestion) => !ADMIN_HINT.test(`${suggestion?.title ?? ""} ${suggestion?.detail ?? ""}`),
  )
  if (kept.length) return kept
  // Bleibt nur Verwaltung uebrig, ist die Session die bessere Quelle.
  return suggestions.length ? fallbackSuggestions(evidence) : suggestions
}

/**
 * Vorschlaege ohne Modell.
 *
 * In langen Sessions kann die Anfrage scheitern (etwa ein 502 vom Anbieter).
 * Ein aus den Belegen abgeleiteter Schritt ist dann immer noch besser als gar
 * keiner: jeder Eintrag nennt genau die Luecke, die er schliesst, und
 * composeTask macht daraus denselben vollstaendigen Auftrag wie sonst.
 */
function fallbackSuggestions(evidence) {
  const files = evidence.edited.length ? evidence.edited : evidence.readOnly
  const list = []
  const add = (kind, title, detail) => {
    if (list.length >= suggestionBudget(evidence)) return
    list.push({ title, detail: withKind(kind, detail), prompt: "" })
  }

  if (evidence.failures.length)
    add(
      "Absichern",
      "Offene Fehlschläge beheben",
      `Ausstehen ${evidence.failures.length} fehlgeschlagene Aufrufe: ${evidence.failures
        .map((failure) => `${failure.tool} ${failure.target || "?"}`)
        .join(", ")}.`,
    )
  if (evidence.code.length && !evidence.tests.length)
    add(
      "Absichern",
      "Tests für die geänderten Dateien nachziehen",
      `Geändert wurden ${evidence.code.join(", ")}, ohne dass eine Testdatei angefasst wurde.`,
    )
  if (evidence.edited.length && !evidence.commands.length)
    add(
      "Absichern",
      "Änderung verifizieren",
      `Die Änderung an ${evidence.edited.join(", ")} wurde mit keinem Befehl geprüft.`,
    )
  if (evidence.edited.length && !evidence.docs.length)
    add("Vertiefen", "Änderung dokumentieren", `Zu ${evidence.edited.join(", ")} wurde keine Dokumentation angepasst.`)
  if (evidence.manifests.length)
    add("Vertiefen", "Abhängigkeiten und Build prüfen", `Beteiligt waren ${evidence.manifests.join(", ")}.`)
  if (!evidence.edited.length && evidence.readOnly.length)
    add("Fortsetzen", "Vom Lesen zur Änderung kommen", `Bisher wurde nur gelesen: ${evidence.readOnly.join(", ")}.`)
  if (!list.length && files.length)
    add("Fortsetzen", "Am letzten Stand weitermachen", `Zuletzt im Spiel: ${files.join(", ")}.`)

  return list
}

// Projektmodus: Verzeichnisse, die nie zum Lesen taugen, und Dateien, die kein
// Text sind. Der Baum wird begrenzt, damit eine grosse Ablage nicht ausartet.
const PROJECT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  ".idea",
  ".vscode",
  ".ruff_cache",
  ".gradle",
  "Pods",
  ".terraform",
  ".nuxt",
  ".output",
])
const PROJECT_SKIP_FILE =
  /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tgz|tar|7z|rar|mp3|mp4|mov|avi|wav|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|jar|class|o|a|lock|db|sqlite3?|wasm|map|snap)$/i
const PROJECT_KEY_FILE =
  /(^|\/)(readme[^/]*|agents\.md|contributing[^/]*|changelog[^/]*|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json|gemfile|dockerfile|makefile|justfile|tsconfig\.json)$/i
const PROJECT_LIMITS = { directories: 160, files: 500, keyFiles: 10, keyChars: 1800, treeChars: 14000, depth: 8 }

// Wenn der erste Versuch am Umfang scheitert (der Anbieter antwortet etwa mit
// 502), wird er mit diesem kleineren Umfang wiederholt: ein groeberer Ueberblick
// ist besser als keiner.
const PROJECT_COMPACT = { ...PROJECT_LIMITS, keyFiles: 4, keyChars: 700, treeChars: 4000 }

/**
 * Vorschlaege allein aus dem Projektbaum.
 *
 * Greift, wenn das Modell nicht erreichbar ist. Anders als fallbackSuggestions
 * sieht das hier nicht die Session, sondern das Projekt: es benennt, was in der
 * Ablage offensichtlich fehlt.
 */
function projectFallback(files, evidence) {
  const has = (pattern) => files.some((path) => pattern.test(path))
  const list = []
  const add = (kind, title, detail) => {
    if (list.length >= suggestionBudget(evidence)) return
    list.push({ title, detail: withKind(kind, detail), prompt: "" })
  }

  if (!has(/(^|\/)(test|tests|spec|specs|__tests__)\//i) && !has(/\.(test|spec)\.[a-z]+$/i))
    add("Absichern", "Tests für das Projekt anlegen", "Im Baum ist keine Testdatei und kein Testverzeichnis zu sehen.")
  if (!has(/(^|\/)readme/i))
    add(
      "Vertiefen",
      "README ergänzen",
      "Im Baum liegt keine README: Zweck, Aufbau und Start des Projekts fehlen damit.",
    )
  if (!has(/(^|\/)\.github\/workflows\//i))
    add("Absichern", "Automatische Prüfung einrichten", "Im Baum ist keine CI-Konfiguration zu sehen.")
  if (!has(/(^|\/)(agents\.md|contributing[^/]*)$/i))
    add(
      "Vertiefen",
      "Beitrags- und Arbeitsregeln festhalten",
      "Es gibt keine Datei mit Regeln für die Mitarbeit (AGENTS.md oder CONTRIBUTING).",
    )
  if (!has(/(^|\/)(dockerfile|compose\.ya?ml)$/i) && has(/(^|\/)package\.json$/i))
    add(
      "Erweitern",
      "Projekt reproduzierbar startbar machen",
      "Neben package.json fehlt eine Container- oder Compose-Definition.",
    )

  for (const suggestion of fallbackSuggestions(evidence)) {
    if (list.length >= suggestionBudget(evidence)) break
    list.push(suggestion)
  }
  return list
}

/**
 * Ein Verzeichnis lesen. Fehler sind hier normal (Rechte, Wettlauf) und werden
 * als leer behandelt: der Ueberblick soll auch mit Luecken entstehen.
 */
async function listProjectDirectory(client, root, path) {
  try {
    const response = await client.file.list({ directory: root, path: path || "." })
    const entries = Array.isArray(response) ? response : (response?.data ?? [])
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

/** Den Dateibaum ab dem Projektverzeichnis einsammeln, verzeichnisweise. */
async function readProjectTree(client, root, onProgress) {
  const files = []
  const queue = [""]
  let directories = 0
  while (queue.length && directories < PROJECT_LIMITS.directories && files.length < PROJECT_LIMITS.files) {
    const batch = queue.splice(0, 6)
    const listings = await Promise.all(batch.map((dir) => listProjectDirectory(client, root, dir)))
    for (const [index, entries] of listings.entries()) {
      directories++
      const dir = batch[index]
      for (const entry of entries) {
        const name = String(entry?.path ?? "")
          .split("/")
          .pop()
        if (!name) continue
        const path = dir ? `${dir}/${name}` : name
        if (entry?.type === "directory") {
          if (PROJECT_IGNORE.has(name)) continue
          if (path.split("/").length >= PROJECT_LIMITS.depth) continue
          queue.push(path)
          continue
        }
        if (PROJECT_SKIP_FILE.test(name)) continue
        files.push(path)
        if (files.length >= PROJECT_LIMITS.files) break
      }
    }
    onProgress?.(directories, files.length)
  }
  return files.sort()
}

/** Eine Textdatei lesen; alles, was keine Zeichenkette ergibt, bleibt weg. */
async function readProjectFile(client, root, path) {
  try {
    const response = await client.file.read({ directory: root, path })
    if (typeof response === "string") return response
    const bytes = response?.data ?? response
    if (bytes instanceof Uint8Array) return new TextDecoder().decode(bytes)
    if (bytes instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(bytes))
    return ""
  } catch {
    return ""
  }
}

/** Die wenigen Dateien lesen, die ueber das Projekt am meisten sagen. */
async function readProjectKeyFiles(client, root, files, onProgress) {
  const wanted = files
    .map((path) => ({ path, rank: PROJECT_KEY_FILE.test(path) ? 0 : 1 }))
    .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
    .slice(0, PROJECT_LIMITS.keyFiles)

  const parts = []
  for (const [index, item] of wanted.entries()) {
    const text = (await readProjectFile(client, root, item.path)).trim()
    if (text) parts.push(`--- ${item.path}\n${clip(text, PROJECT_LIMITS.keyChars)}`)
    onProgress?.(index + 1, wanted.length)
  }
  return parts
}

/** Antwort des Projektmodus: Uebersicht plus Vorschlaege. */
function parseProjectReport(raw) {
  const text = String(raw ?? "").trim()
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(text)
  const candidate = fenced?.[1] ?? objectSlice(text)
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
        return {
          summary: clip(String(parsed.summary ?? parsed.ueberblick ?? "").trim(), 1200),
          suggestions: parseSuggestions(JSON.stringify(parsed.suggestions ?? [])),
        }
      }
    } catch {
      /* dann bleibt nur der Vorschlagsteil */
    }
  }
  return { summary: "", suggestions: parseSuggestions(raw) }
}

function objectSlice(text) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start !== -1 && end > start ? text.slice(start, end + 1) : ""
}

const STACK_MARKERS = [
  { test: /(^|\/)package\.json$/, name: "Node/JS" },
  { test: /(^|\/)tsconfig[^/]*\.json$/, name: "TypeScript" },
  { test: /(^|\/)bun\.lockb?$/, name: "Bun" },
  { test: /(^|\/)pnpm-lock\.yaml$/, name: "pnpm" },
  { test: /(^|\/)yarn\.lock$/, name: "Yarn" },
  { test: /(^|\/)package-lock\.json$/, name: "npm" },
  { test: /(^|\/)pyproject\.toml$/, name: "Python" },
  { test: /(^|\/)cargo\.toml$/i, name: "Rust" },
  { test: /(^|\/)go\.mod$/, name: "Go" },
  { test: /(^|\/)pom\.xml$/, name: "Maven/Java" },
  { test: /(^|\/)build\.gradle(\.kts)?$/, name: "Gradle/Android" },
  { test: /(^|\/)project\.godot$/, name: "Godot" },
  { test: /(^|\/)composer\.json$/, name: "PHP" },
  { test: /(^|\/)gemfile$/i, name: "Ruby" },
  { test: /(^|\/)flake\.nix$/, name: "Nix" },
  { test: /(^|\/)dockerfile$/i, name: "Docker" },
  { test: /(^|\/)compose\.ya?ml$/i, name: "Compose" },
]

const PROJECT_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "kt",
  "java",
  "cs",
  "swift",
  "rb",
  "php",
  "lua",
  "gd",
  "vue",
  "svelte",
  "css",
  "scss",
  "html",
  "md",
  "sql",
  "proto",
  "sh",
  "yml",
  "toml",
  "json",
]

const BUILT_MARKERS = [
  { test: /(^|\/)(test|tests|spec|specs|__tests__)\//i, label: "Tests" },
  { test: /\.(test|spec)\.[a-z]+$/i, label: "Tests" },
  { test: /(^|\/)readme/i, label: "Dokumentation (README)" },
  { test: /(^|\/)(docs?|documentation)\//i, label: "Dokumentation" },
  { test: /(^|\/)\.github\/workflows\//i, label: "Automatische Prüfung (CI)", required: true },
  { test: /(^|\/)(dockerfile|compose\.ya?ml)$/i, label: "Container/Start" },
  { test: /(^|\/)license/i, label: "Lizenz" },
  { test: /(^|\/)(migrations?|schema\.sql)\b/i, label: "Datenbank/Schema" },
  { test: /(^|\/)(routes?|router|api|handlers?)\b/i, label: "API/Routen" },
  { test: /(^|\/)(components?|pages?|views?)\b/i, label: "Oberfläche" },
  { test: /(^|\/)(cli|bin)\b/i, label: "Kommandozeile" },
  { test: /(^|\/)(plugins?|extensions?)\b/i, label: "Erweiterungen" },
  { test: /(^|\/)i18n\//i, label: "Übersetzungen" },
  { test: /(^|\/)(\.env\.example|\.env\.template)$/i, label: "Konfigurationsvorlage" },
]

const PROJECT_REQUIRED = [
  { test: /(^|\/)(test|tests|spec|specs|__tests__)\//i, label: "Tests" },
  { test: /\.(test|spec)\.[a-z]+$/i, label: "Tests" },
  { test: /(^|\/)readme/i, label: "README" },
  { test: /(^|\/)\.github\/workflows\//i, label: "CI" },
  { test: /(^|\/)license/i, label: "Lizenz" },
  { test: /(^|\/)(dockerfile|compose\.ya?ml)$/i, label: "Container/Start" },
]

/** Die Skriptnamen aus package.json, falls sie in den Schlüsseldateien steht. */
function manifestScripts(keyFiles) {
  const block = (keyFiles ?? []).find((part) => part.startsWith("--- package.json"))
  if (!block) return ""
  try {
    const parsed = JSON.parse(block.slice(block.indexOf("\n") + 1))
    const names = Object.keys(parsed.scripts ?? {})
    return names.slice(0, 12).join(", ")
  } catch {
    return ""
  }
}

/**
 * Technische Einordnung des Projekts — aus der Ablage abgeleitet, nicht geraten.
 *
 * Das Modell soll nicht erraten, was fuer ein Projekt das ist und was schon
 * steht: Oekosystem, Sprachen, Schwerpunkte im Baum, Vorhandenes und Fehlendes
 * werden hier deterministisch bestimmt und mitgeschickt. Das macht die
 * Vorschlaege belastbar und den Auftrag kleiner.
 */
const FEATURE_HINT =
  /(^|\/)(features?|components?|pages?|views?|screens?|routes?|routers?|handlers?|services?|commands?|plugins?|extensions?|modules?|widgets?|api|ui|desktop|app|core|session)\//i
const FEATURE_LIMITS = { files: 48, chars: 6000, symbols: 8, routes: 6, text: 9000 }

/**
 * Die gebauten Merkmale aus den Quellen ableiten — grob, aber belegt.
 *
 * Aus jeder aussagekraeftigen Datei werden nur Signale gezogen: Kopfkommentar,
 * oeffentliche Namen und erkennbare Routen. Damit sieht das Modell, was schon
 * gebaut ist und an welchen Baustein es anknuepfen kann, ohne dass ganze
 * Dateien in den Auftrag wandern.
 */
async function readFeatureSignals(client, root, files, onProgress) {
  const candidates = files
    .filter((path) => FEATURE_HINT.test(path))
    .filter((path) => !/(^|\/)(test|tests|spec|specs|__tests__)\//i.test(path) && !/\.(test|spec)\./i.test(path))
    .filter((path) => !/(^|\/)(package\.json|tsconfig[^/]*\.json|.*\.d\.ts|index\.(js|ts))$/i.test(path))
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))
    .slice(0, FEATURE_LIMITS.files)

  const signals = []
  for (const [index, path] of candidates.entries()) {
    const text = await readProjectFile(client, root, path)
    const signal = extractSignal(path, text)
    if (signal) signals.push(signal)
    onProgress?.(index + 1, candidates.length)
  }
  return signals
}

function extractSignal(path, text) {
  const source = String(text ?? "").slice(0, FEATURE_LIMITS.chars)
  if (!source.trim()) return undefined

  const doc = clip(
    (/^\s*(\/\*\*?([\s\S]*?)\*\/)/.exec(source)?.[2] ?? /^\s*("""([\s\S]*?)""")/.exec(source)?.[2] ?? "")
      .split("\n")
      .map((line) => line.replace(/^\s*[*/#]+\s?/, "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" "),
    170,
  )

  const symbols = [
    ...new Set(
      [...source.matchAll(/\bexport\s+(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)]
        .map((match) => match[1])
        .concat(
          [...source.matchAll(/^\s*(?:pub\s+)?(?:def|fn|func|class)\s+([A-Za-z_][\w]*)/gm)].map((match) => match[1]),
        ),
    ),
  ].slice(0, FEATURE_LIMITS.symbols)

  const routes = [
    ...new Set(
      [...source.matchAll(/["'`](\/(?:api|v\d)?\/?[a-z0-9:[\]_-]+(?:\/[a-z0-9:[\]_.-]+)*)["'`]/gi)].map(
        (match) => match[1],
      ),
    ),
  ]
    .filter((route) => route.length > 1 && route.length < 60)
    .slice(0, FEATURE_LIMITS.routes)

  if (!doc && !symbols.length && !routes.length) return undefined
  return { path, doc, symbols, routes }
}

function featureText(signals) {
  if (!signals.length) return ""
  return [
    "GEBAUTE MERKMALE (aus Dateinamen, Kopfkommentaren, öffentlichen Namen und Routen abgeleitet):",
    clip(
      signals
        .map((signal) =>
          [
            `· ${signal.path}${signal.doc ? ` — ${signal.doc}` : ""}`,
            signal.symbols.length ? `  öffentlich: ${signal.symbols.join(", ")}` : "",
            signal.routes.length ? `  Pfade: ${signal.routes.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n"),
      FEATURE_LIMITS.text,
    ),
  ].join("\n")
}

function analyzeProject(files, keyFiles, signals) {
  const has = (pattern) => files.some((path) => pattern.test(path))

  const stack = STACK_MARKERS.filter((marker) => has(marker.test)).map((marker) => marker.name)
  const languages = PROJECT_EXTENSIONS.map((name) => ({
    name,
    files: files.filter((path) => path.toLowerCase().endsWith(`.${name}`)).length,
  }))
    .filter((item) => item.files > 0)
    .sort((left, right) => right.files - left.files)
    .slice(0, 8)

  const groups = new Map()
  for (const path of files) {
    const segment = path.includes("/") ? path.split("/")[0] : "(Wurzel)"
    groups.set(segment, (groups.get(segment) ?? 0) + 1)
  }
  const layout = [...groups.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 14)
    .map(([name, count]) => `${name} (${count})`)

  const built = [...new Set(BUILT_MARKERS.filter((marker) => has(marker.test)).map((marker) => marker.label))]
  const missing = [...new Set(PROJECT_REQUIRED.filter((marker) => !has(marker.test)).map((marker) => marker.label))]
  const scripts = manifestScripts(keyFiles)

  const areas = detectAreas(files)
  const text = [
    "TECHNISCHE EINORDNUNG (aus der Ablage abgeleitet, nicht geraten):",
    `- Ökosystem und Werkzeuge: ${stack.join(", ") || "keine typischen Manifeste gefunden"}`,
    `- Sprachen nach Dateizahl: ${languages.map((item) => `${item.name} ${item.files}`).join(", ") || "keine erkannt"}`,
    `- Schwerpunkte im Baum: ${layout.join(", ") || "keine"}`,
    `- Bereits vorhanden: ${built.join(", ") || "nichts davon erkannt"}`,
    `- Fehlt offensichtlich: ${missing.join(", ") || "nichts davon erkannt"}`,
    scripts ? `- Skripte laut Manifest: ${scripts}` : "",
    areas.length
      ? `- Erkannte Bereiche: ${areas.map((area) => `${area.label}${area.mandatory ? " (Pflichtvorschlag)" : ""}`).join(", ")}`
      : "- Erkannte Bereiche: keine",
    ...areas.map((area) => `  · ${area.label}: ${area.samples.join(", ")}`),
    `- Lesbare Textdateien insgesamt: ${files.length}`,
    featureText(signals ?? []),
  ]
    .filter((line) => line !== "")
    .join("\n")

  return { text, missing, built, stack, areas, files, count: files.length }
}

/**
 * Bereiche, die im Projekt erkannt werden koennen. `mandatory` heißt: gibt es
 * den Bereich, gehoert genau ein Vorschlag dazu — auch dann, wenn das Modell
 * keinen liefert (s. ensureAreaSuggestions).
 */
const PROJECT_AREAS = [
  {
    key: "gui",
    label: "Oberfläche (GUI)",
    mandatory: true,
    test: /\.(tsx|jsx|vue|svelte|qml)$|(^|\/)(components?|pages?|views?|screens?|ui|widgets?|desktop|app)\//i,
  },
  {
    key: "architecture",
    label: "Architektur",
    mandatory: true,
    test: /(^|\/)(packages|apps|libs|modules|crates|services|core|shared|platform)\//i,
  },
  {
    key: "api",
    label: "API und Server",
    test: /(^|\/)(routes?|router|api|handlers?|endpoints?|controllers?|server)\//i,
  },
  { key: "cli", label: "Kommandozeile", test: /(^|\/)(cli|bin|commands?)\//i },
  { key: "data", label: "Daten und Schema", test: /(^|\/)(migrations?|schema|models?|entities|database|db)\b/i },
  { key: "plugins", label: "Erweiterungen", test: /(^|\/)(plugins?|extensions?|addons?)\//i },
  { key: "tests", label: "Tests", test: /(^|\/)(test|tests|spec|specs|__tests__)\//i },
  { key: "docs", label: "Dokumentation", test: /(^|\/)(docs?|documentation)\//i },
  { key: "ci", label: "Automatisierung", test: /(^|\/)\.github\/workflows\//i },
  { key: "i18n", label: "Übersetzungen", test: /(^|\/)(i18n|locales?|translations?)\//i },
  { key: "mobile", label: "Mobile", test: /(^|\/)android\//i },
  { key: "desktop", label: "Desktop", test: /(^|\/)(electron|tauri|desktop)\//i },
  { key: "game", label: "Spiel", test: /(^|\/)(scenes?|levels?)\/|\.tscn$/i },
]

/** Was ein Pflichtbereich vorschlaegt, wenn das Modell ihn auslaesst. */
const AREA_TEMPLATES = {
  gui: {
    kind: "Erweitern",
    title: "Oberfläche um einen Bedienweg erweitern",
    lead: "Die Oberfläche besteht aus",
    tail: "Eine neue Ansicht oder ein neuer Bedienweg baut darauf auf.",
  },
  architecture: {
    kind: "Erweitern",
    title: "Architektur um einen Baustein erweitern",
    lead: "Die Struktur des Projekts zeigt",
    tail: "Ein neuer Baustein oder eine klarere Grenze zwischen den Teilen baut darauf auf.",
  },
}

function detectAreas(files) {
  return PROJECT_AREAS.map((area) => ({
    ...area,
    samples: files.filter((path) => area.test.test(path)).slice(0, 5),
  })).filter((area) => area.samples.length > 0)
}

/**
 * Erzwingt die Pflichtbereiche.
 *
 * Ein Projekt mit Oberfläche soll immer je einen Vorschlag zur Oberfläche und
 * zur Architektur bekommen — auch dann, wenn das Modell keinen liefert. Fehlt
 * einer, wird er aus den erkannten Dateien gebaut; das Modell darf ihn nicht
 * wegfallen lassen.
 */
function ensureAreaSuggestions(suggestions, areas, budget) {
  const list = [...suggestions]
  const hasArea = (key) =>
    list.some(
      (suggestion) =>
        suggestion?.area === key ||
        (key === "gui" &&
          /\b(gui|ui|oberfläche|oberflaeche|ansicht|bedien|fenster)\b/i.test(
            `${suggestion?.title} ${suggestion?.detail}`,
          )) ||
        (key === "architecture" &&
          /\b(architektur|struktur|schicht|modul|paket|baustein)\b/i.test(
            `${suggestion?.title} ${suggestion?.detail}`,
          )),
    )

  const guaranteed = []
  for (const area of areas) {
    if (!area.mandatory || hasArea(area.key)) continue
    const template = AREA_TEMPLATES[area.key]
    if (!template) continue
    guaranteed.push({
      area: area.key,
      title: template.title,
      detail: withKind(template.kind, `${template.lead} ${area.samples.join(", ")}. ${template.tail}`),
      prompt: "",
    })
  }

  if (!guaranteed.length) return list.slice(0, budget)

  // Fuer die Pflichtbereiche wird Platz freigehalten; das Modell darf sie nicht
  // verdraengen. Der Rest behaelt seine Reihenfolge.
  return [...list.slice(0, Math.max(0, budget - guaranteed.length)), ...guaranteed].slice(0, budget)
}

function buildProjectPrompt(root, analysis, keyFiles, focus, limits) {
  const size = limits ?? PROJECT_LIMITS
  return [
    "AUFGABE: Verschaffe dir einen Überblick über dieses Projekt und schlage danach die nächsten Arbeiten vor.",
    'Antworte ausschließlich mit einem JSON-Objekt der Form {"summary":"…","suggestions":[…]}, ohne Codezaun, ohne Vorwort.',
    "`summary` ordnet das Projekt in 4 bis 8 Sätzen ein: wozu es dient, wie es aufgebaut ist, welche Technik es nutzt, wie weit es ist und was offensichtlich fehlt.",
    "`suggestions` ist ein Array mit höchstens " +
      MAX_SUGGESTIONS +
      " Einträgen, jeweils {kind, title, detail, prompt, area}.",
    `Pflichtregel zu den Bereichen: Für jeden Bereich, der unten als Pflichtvorschlag steht, gehört genau ein Vorschlag dazu, der diesen Bereich erweitert. Für die übrigen erkannten Bereiche gilt: mindestens einer, solange die Ablage Belege hergibt.`,
    "`area` benennt den Bereich eines Vorschlags mit genau einem dieser Schlüssel: " +
      PROJECT_AREAS.map((area) => `"${area.key}"`).join(", ") +
      ".",
    'Ein Vorschlag zur Oberfläche (area "gui") erweitert die Bedienung — neue Ansicht, neuer Bedienweg, bessere Rückmeldung. Er ändert nicht nur Farben oder Abstände.',
    'Ein Vorschlag zur Architektur (area "architecture") erweitert oder klärt den Aufbau — neuer Baustein, klarere Grenze, bessere Zerlegung. Er ist kein Sammeltitel für Aufräumarbeiten.',
    '`kind` ist genau einer von: "Erweitern", "Vertiefen", "Fortsetzen", "Absichern". Schwerpunkt ist der Ausbau, Absicherung die Ausnahme.',
    "`prompt` ist der fertige Auftrag, der später wortgleich in den Chat geht: mehrere Sätze, für sich verständlich, mit Ziel, betroffenen Dateien und woran die Fertigstellung zu erkennen ist.",
    "Stütze dich ausschließlich auf das, was unten steht; erfinde keine Dateien und keine Probleme. Nenne eine Datei nur, wenn sie im Baum vorkommt.",
    "Die technische Einordnung ist abgeleitet, nicht geraten — baue deine Vorschläge darauf auf: nenne den Stand, den du dort findest, und knüpfe an das an, was schon gebaut ist.",
    "Die Liste der gebauten Merkmale zeigt bestehende Bausteine mit ihren öffentlichen Namen. Jeder Vorschlag soll den Baustein benennen, an den er anknüpft — notfalls über den Pfad.",
    "Was in der Einordnung als fehlend steht, ist ein belegter Anknüpfungspunkt, aber nicht automatisch ein Vorschlag.",
    'Jeder Vorschlag ist technische Arbeit am Code oder am Projekt: bauen, umbauen, prüfen, verstehen. Rein Organisatorisches ist kein Vorschlag — kein "git commit", kein "push", kein Release, kein Changelog, kein Ticket, kein Termin.',
    "Wenn das Projekt zu wenig hergibt, liefere weniger Vorschläge statt geratener.",
    focus ? `Besonderes Augenmerk: ${focus}` : "",
    "",
    `PROJEKTVERZEICHNIS: ${root}`,
    analysis.text,
    "",
    `DATEIEN IM BAUM (${analysis.count}, gekürzt):`,
    clip(analysis.files.join("\n"), size.treeChars),
    "",
    `SCHLÜSSELDATEIEN (${keyFiles.length} von höchstens ${size.keyFiles}, gekürzt):`,
    keyFiles.join("\n\n") || "(keine lesbare Schlüsseldatei gefunden)",
    "",
    "Das erste Zeichen deiner Antwort ist { und das letzte }.",
  ]
    .filter((line) => line !== "")
    .join("\n")
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
  return { id: keep.id, owned: keep.metadata?.[FORM_OWNER] === owner, removed: duplicates.length }
}

function cancelForm(client, sessionID, formID) {
  return client.session.form.cancel({ sessionID, formID }).catch(() => undefined)
}

export default {
  id: "auto-suggest",

  async setup(context) {
    const { client, data, ui, keymap, storage, location } = context

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

    /** Das Projektverzeichnis dieser Session, so genau wie die API es hergibt. */
    const sessionDirectory = (sessionID) => {
      try {
        const info = data.session.get?.(sessionID)
        const directory = info?.location?.directory ?? info?.directory
        if (directory) return directory
      } catch {
        /* naechste Quelle */
      }
      try {
        const root = data.session.root?.(sessionID)
        if (root) return root
      } catch {
        /* naechste Quelle */
      }
      try {
        const directory = location?.directory ?? location?.current?.directory
        if (directory) return directory
      } catch {
        /* keine Quelle */
      }
      return undefined
    }

    /**
     * Das Auswahlformular anlegen.
     *
     * `message` zeigt im Formular eine kurze Einordnung — im Projektmodus die
     * Uebersicht. Die Anforderungsmarke gehoert immer dazu, nur so bleibt das
     * Formular von der Wache unangetastet.
     */
    async function openSuggestionForm(sessionID, { suggestions, title, message }) {
      const created = await client.session.form.create({
        sessionID,
        title,
        metadata: { [FORM_OWNER]: INSTANCE_ID, [REQUEST_MARK]: true, ...(message ? { message } : {}) },
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
        return undefined
      }
      note({ action: "opened", sessionID, form: formID, count: suggestions.length })
      return formID
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
          note({ action: "reuse", sessionID, form: openForm.id, owned: openForm.owned, removed: openForm.removed })
          if (openForm.owned) await submitSelection(sessionID, openForm, undefined, evidence)
          return true
        }

        // Die Abfrage dauert je nach Groesse der Session mehrere Sekunden. Ohne
        // Rueckmeldung wirkt das wie ein Haenger.
        toast("Frage das Modell nach Vorschlägen …", "info")

        // In langen Sessions scheitert die Anfrage mitunter (etwa ein 502 des
        // Anbieters). Dann darf der Befehl nicht ins Leere laufen: es gibt
        // Vorschlaege aus den Belegen.
        let generated
        try {
          generated = await client.session.generate({ sessionID, prompt: buildPrompt(evidence, focus) })
        } catch (cause) {
          toast(`Modell nicht erreichbar (${cause?.message ?? cause}) — Vorschläge aus den Belegen`, "warning")
        }

        // Zweite, belegbasierte Bremse: das Modell darf sich an der Obergrenze
        // nicht vorbeireden. Bei mehr Vorschlägen als die Session trägt, fliegt
        // der Rest hier raus.
        const suggestions = technicalOnly(
          generated
            ? parseSuggestions(generated?.text ?? generated).slice(0, suggestionBudget(evidence))
            : fallbackSuggestions(evidence),
          evidence,
        )

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
        const formID = await openSuggestionForm(sessionID, { suggestions, title })
        if (!formID) return false

        // Hat ein zweites Fenster gleichzeitig angelegt, bleibt genau eines
        // stehen — und zwar dasselbe in beiden Fenstern (das aelteste). Wer es
        // nicht selbst angelegt hat, steigt hier aus: das andere Fenster wartet
        // darauf und schickt die Auswahl ab.
        const sole = (await keepSoleForm(client, sessionID, INSTANCE_ID)) ?? { id: formID, owned: true, removed: 0 }
        if (sole.removed) note({ action: "sole", sessionID, form: sole.id, owned: sole.owned, removed: sole.removed })
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
    async function submitSelection(sessionID, form, suggestions, evidence, extra) {
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
          text: composeTask(evidence, suggestion, { index: index + 1, total: picked.length }, extra),
          ...(index === 0 ? {} : { delivery: "queue" }),
        })
      }
      note({ action: "submitted", sessionID, count: picked.length })
    }

    /**
     * Vorschlaege aus dem ganzen Projekt statt nur aus dieser Session.
     *
     * Liest den Baum ab dem Projektverzeichnis, dazu die wenigen Dateien, die
     * ueber das Projekt am meisten sagen, laesst beides zusammenfassen und baut
     * daraus die Vorschlaege. Weil das dauert, meldet jeder Schritt seinen
     * Fortschritt.
     */
    async function askProject(sessionID, focus) {
      if (pending || !sessionID) return false

      const root = sessionDirectory(sessionID)
      if (!root) {
        toast("Kein Projektverzeichnis gefunden", "warning")
        return false
      }

      const { evidence } = readEvidence(sessionID)
      pending = true
      try {
        toast(`Projekt lesen: ${root}`, "info")
        const files = await readProjectTree(client, root, (directories, count) => {
          if ((directories + count) % 10 !== 0) return
          toast(`Projekt lesen … ${directories} Verzeichnisse, ${count} Dateien`, "info")
        })
        if (!files.length) {
          toast("Im Projektverzeichnis wurde nichts Lesbares gefunden", "warning")
          return true
        }

        toast(`Projektbaum gelesen: ${files.length} Dateien — Schlüsseldateien folgen`, "info")
        const keyFiles = await readProjectKeyFiles(client, root, files, (done, total) => {
          toast(`Schlüsseldateien ${done}/${total}`, "info")
        })

        const signals = await readFeatureSignals(client, root, files, (done, total) => {
          if (done % 8 !== 0 && done !== total) return
          toast(`Merkmale aus den Quellen lesen … ${done}/${total}`, "info")
        })
        const analysis = analyzeProject(files, keyFiles, signals)
        toast("Wertee das Projekt technisch aus und baue Vorschläge …", "info")
        let generated
        try {
          generated = await client.session.generate({
            sessionID,
            prompt: buildProjectPrompt(root, analysis, keyFiles, focus),
          })
        } catch (cause) {
          // Scheitert der erste Versuch am Umfang (der Anbieter antwortet etwa
          // mit 502), wird kleiner nachgefasst.
          toast(`Erster Versuch zu groß (${cause?.message ?? cause}) — noch einmal kompakt`, "warning")
          try {
            generated = await client.session.generate({
              sessionID,
              prompt: buildProjectPrompt(root, analysis, keyFiles, focus, PROJECT_COMPACT),
            })
          } catch (again) {
            toast(`Modell nicht erreichbar (${again?.message ?? again}) — Vorschläge aus dem Projekt`, "warning")
          }
        }

        const report = generated ? parseProjectReport(generated?.text ?? generated) : { summary: "", suggestions: [] }
        const suggestions = ensureAreaSuggestions(
          technicalOnly(report.suggestions.length ? report.suggestions : projectFallback(files, evidence), evidence),
          analysis.areas,
          suggestionBudget(evidence),
        ).slice(0, MAX_SUGGESTIONS)
        if (!suggestions.length) {
          toast("Das Projekt gibt keinen nächsten Schritt her", "info")
          return true
        }

        const extra = [
          `Projektverzeichnis: ${root}`,
          `Gelesene Projektdateien: ${files.length}`,
          report.summary ? `Projektübersicht: ${report.summary}` : "",
        ].filter(Boolean)

        const formID = await openSuggestionForm(sessionID, {
          suggestions,
          title: `Nächste Schritte im Projekt (${suggestions.length})`,
          message: report.summary ? clip(report.summary, 400) : `Projektüberblick über ${files.length} Dateien`,
        })
        if (!formID) return false

        const sole = (await keepSoleForm(client, sessionID, INSTANCE_ID)) ?? { id: formID, owned: true, removed: 0 }
        if (!sole.owned) return true
        await submitSelection(sessionID, sole, suggestions, evidence, extra)
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
        {
          id: "session.suggestProject",
          title: "Suggest next steps for the whole project",
          description: "Liest das Projektverzeichnis, fasst es zusammen und schlägt nächste Schritte vor",
          group: "Session",
          palette: true,
          slash: { name: "nextProject", arguments: true },
          run(input) {
            const sessionID = currentSession()
            if (!sessionID) {
              toast("Open a session first", "warning")
              return
            }
            void askProject(sessionID, typeof input === "string" ? input.trim() || undefined : undefined)
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

    // Sofort statt bis zu zwei Sekunden spaeter: das Ereignis meldet das neu
    // angelegte Formular, und ohne Anforderungsmarke wird es auf der Stelle
    // abgebrochen. Das greift auch fuer Formulare, die nicht ueber dieses
    // Client-Objekt entstehen (etwa aus einem alten Zuhoerer mit aelterem
    // Client) und die deshalb am Abfangen beim Anlegen vorbeikommen.
    const onFormCreated = (event) => {
      const form = event?.data?.form
      if (!form?.id || form.sessionID === "global") return
      if (form.metadata?.[REQUEST_MARK] === true) return
      if (!(form.fields ?? []).some((field) => field?.key === FORM_KEY)) return
      note({ action: "drop", sessionID: form.sessionID, form: form.id })
      void cancelForm(client, form.sessionID, form.id)
    }

    let unsubscribeFormCreated
    try {
      unsubscribeFormCreated = data.on("form.created", onFormCreated)
    } catch {
      /* Ereignis nicht verfuegbar */
    }

    return () => {
      clearInterval(guard)
      if (typeof unsubscribeFormCreated === "function") {
        try {
          unsubscribeFormCreated()
        } catch {
          /* bereits abgemeldet */
        }
      }
    }
  },
}
