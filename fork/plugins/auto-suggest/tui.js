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

// Ein gefilterter Lauf fragt nur einen einzigen Bereich ab. Mehr als eine Handvoll
// Vorschlaege dazu waeren Wiederholungen mit anderem Wortlaut.
const FILTER_SUGGESTIONS = 5

// Wie lange ein einmal gelesener Projektbericht gilt und wie viele Berichte
// hoechstens aufgehoben werden (je Projektverzeichnis einer).
const PROJECT_REPORT_TTL_MS = 5 * 60 * 1000
const PROJECT_REPORT_MAX = 4

// Was schon vorgeschlagen wurde, wird nicht noch einmal vorgeschlagen. Je
// Sitzung und je Projektverzeichnis werden die letzten Titel gehalten; die Zahl
// der Schluessel ist begrenzt, damit die Ablage nicht unbegrenzt waechst.
const ASKED_MAX = 80
const ASKED_KEYS = 24

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
function buildPrompt(evidence, focus, seen) {
  const { hint, areas } = focusParts(focus)
  const budget = areas.length ? Math.min(suggestionBudget(evidence), FILTER_SUGGESTIONS) : suggestionBudget(evidence)
  const band = budget === MIN_SUGGESTIONS ? `${MIN_SUGGESTIONS}` : `${MIN_SUGGESTIONS} bis ${budget}`
  const scope = areas.length ? areas.map((area) => `${area.label} (area "${area.key}")`).join(", ") : ""

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
    `Mehr als ${budget} werden es nie. Wird es weniger, dann nur, weil es nichts anderes mehr gibt: statt zu wiederholen oder leer zu antworten, geh tiefer in dieselben Belege.`,
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
    '5. Die Mehrheit sind "Erweitern": mindestens die Hälfte, ab sechs Vorschlägen mindestens zwei Drittel. Sie dürfen über den bisherigen Faden hinausdenken, solange sie an die Belege anknüpfen.',
    '6. Höchstens einer ist "Fortsetzen" und höchstens einer ist "Absichern"; ab acht Vorschlägen höchstens zwei. Alles Übrige ist "Vertiefen".',
    "7. Eine leere Antwort ist ungültig. Gibt es nichts Naheliegendes mehr, geh tiefer in dieselbe Ablage — ein anderer Aspekt derselben Sache, ein anderer Baustein, ein Rand- oder Fehlerfall, eine Alternative, der nächste Ausbauschritt. Tiefer heißt nicht erfunden: die Belege bleiben die Grundlage.",
    'Jeder Vorschlag ist technische Arbeit am Code oder am Projekt: bauen, umbauen, prüfen, verstehen. Rein Organisatorisches ist kein Vorschlag — kein "git commit", kein "push", kein Release, kein Changelog, kein Ticket, kein Termin.',
    'Ein "Erweitern"-Vorschlag ist ein vollständiges Feature, kein Detail: eine neue Funktion, eine neue Ansicht, ein neuer Modus, ein neuer Befehl, eine neue Auswertung, eine neue Automatik oder ein neuer Anwendungsfall.',
    "Er nennt den Nutzen in einem Satz, den Weg dorthin (wo im Code es ansetzt) und was neu entsteht. Im `prompt` steht das Feature als Ganzes, nicht sein erster Handgriff.",
    'Jeder "Erweitern"-Vorschlag verbessert die Nutzung: weniger Schritte, klarere Rückmeldung oder mehr Möglichkeiten als heute. Ein Erweitern-Vorschlag, der nur umbenennt, umsortiert oder aufräumt, ist keiner.',
    scope
      ? `8. Es kommt ausschließlich zu diesen Bereichen: ${scope}. Jeder Vorschlag gehört zu einem davon; alles andere ist falsch.${hint ? ` Zusätzlich im Blick: ${hint}` : ""}`
      : hint
        ? `8. Besonderes Augenmerk: ${hint}`
        : "",
    "",
    askedBlock(seen),
    "",
    "BELEGE (nur diese, keine Annahmen darüber hinaus):",
    lines.join("\n"),
    "",
    scope
      ? 'Antworte jetzt ausschließlich mit einem JSON-Array der Form [{"kind":"…","title":"…","detail":"…","prompt":"…","area":"…"}]. `area` ist einer dieser Schlüssel: ' +
        areas.map((area) => `"${area.key}"`).join(", ") +
        "."
      : 'Antworte jetzt ausschließlich mit einem JSON-Array der Form [{"kind":"…","title":"…","detail":"…","prompt":"…"}].',
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

/**
 * Worte eines Titels, vergleichbar gemacht.
 *
 * Kleingeschrieben, Fuellwoerter weg, Satzzeichen an den Raendern weg — Pfade
 * wie `src/a.ts` bleiben aber ein einziges Wort. Sonst gaelten "Tests fuer
 * src/a.ts" und "Tests fuer src/b.ts" als dieselbe Arbeit.
 */
const TITLE_STOP = new Set([
  "für",
  "fuer",
  "und",
  "der",
  "die",
  "das",
  "den",
  "dem",
  "mit",
  "von",
  "im",
  "in",
  "auf",
  "aus",
  "zur",
  "zum",
  "ein",
  "eine",
  "einen",
  "ohne",
  "als",
  "ist",
  "sind",
  "nach",
  "vor",
  "bei",
  "über",
  "ueber",
  "am",
  "an",
  "des",
])

function titleTokens(title) {
  return String(title ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}/._-]+|[^\p{L}\p{N}/._-]+$/gu, ""))
    .filter((word) => word.length > 1 && !TITLE_STOP.has(word))
}

/**
 * Ist das dieselbe Arbeit?
 *
 * Gleiche Worte in anderer Reihenfolge oder derselbe Kern mit einem Anhang
 * gelten als Wiederholung: "Tests für src/a.ts" und "Tests für src/a.ts
 * nachziehen" sind derselbe Vorschlag, nicht zwei.
 */
function sameWork(left, right) {
  const a = new Set(titleTokens(left))
  const b = new Set(titleTokens(right))
  if (!a.size || !b.size) return false
  if ([...a].every((token) => b.has(token)) && a.size === b.size) return true
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  if (small.size < 2) return false
  if (![...small].every((token) => big.has(token))) return false
  return small.size / big.size >= 0.6
}

/** Steht dieser Vorschlag schon in der Liste des Schon-gefragt? */
function isRepeat(title, seen) {
  const key = titleTokens(title).join(" ")
  if (!key) return false
  return (seen ?? []).some((entry) => titleTokens(entry).join(" ") === key || sameWork(title, entry))
}

/** Nur was es so noch nicht gab. */
function freshSuggestions(suggestions, seen) {
  return (suggestions ?? []).filter((suggestion) => !isRepeat(suggestion?.title, seen))
}

/**
 * Was je Datei an Arbeit denkbar ist.
 *
 * Der Vorrat fuer den Fall, dass das Modell nur Bekanntes liefert: der Lauf darf
 * nicht leer ausgehen, also wird aus dem abgeleitet, was wirklich dasteht. Je
 * Datei und je Zeile eine andere Arbeit — Tests, Raender, Fehlerpfade,
 * Dokumentation, Nutzung, Aufteilung, Eingaben, Rueckmeldungen.
 */
const DERIVE_FILE_STEPS = [
  {
    kind: "Absichern",
    title: (file) => `Tests für ${file} nachziehen`,
    detail: (file) => `Für ${file} ist kein Test im Spiel.`,
  },
  {
    kind: "Absichern",
    title: (file) => `Randfälle in ${file} abdecken`,
    detail: (file) => `Die Ränder von ${file} sind ungeprüft.`,
  },
  {
    kind: "Absichern",
    title: (file) => `Fehlerpfade in ${file} prüfen`,
    detail: (file) => `${file} behandelt Fehlerfälle nicht erkennbar.`,
  },
  {
    kind: "Absichern",
    title: (file) => `Ungeprüfte Eingaben in ${file} abfangen`,
    detail: (file) => `Was in ${file} ankommt, wird nicht geprüft.`,
  },
  {
    kind: "Absichern",
    title: (file) => `Zwischenstände in ${file} prüfen`,
    detail: (file) => `Was ${file} zwischendurch liefert, wird nirgends geprüft.`,
  },
  {
    kind: "Vertiefen",
    title: (file) => `${file} dokumentieren`,
    detail: (file) => `Zu ${file} wurde keine Dokumentation angepasst.`,
  },
  {
    kind: "Vertiefen",
    title: (file) => `Nutzung von ${file} beschreiben`,
    detail: (file) => `Wie ${file} benutzt wird, steht nirgends.`,
  },
  {
    kind: "Vertiefen",
    title: (file) => `${file} in kleinere Einheiten teilen`,
    detail: (file) => `${file} trägt mehrere Aufgaben auf einmal.`,
  },
  {
    kind: "Vertiefen",
    title: (file) => `Tote Pfade in ${file} entfernen`,
    detail: (file) => `${file} führt Wege mit, die niemand mehr geht.`,
  },
  {
    kind: "Erweitern",
    title: (file) => `Rückmeldungen aus ${file} verbessern`,
    detail: (file) => `${file} meldet Fehler nicht verständlich.`,
  },
  {
    kind: "Erweitern",
    title: (file) => `${file} um einen Anwendungsfall erweitern`,
    detail: (file) => `${file} deckt bisher nur den offensichtlichen Fall ab.`,
  },
  {
    kind: "Fortsetzen",
    title: (file) => `An ${file} weiterarbeiten`,
    detail: (file) => `${file} war zuletzt im Spiel und ist nicht abgeschlossen.`,
  },
]

/** Wie ein späterer Durchgang heißt, wenn alles schon dran war. */
const DERIVE_ROUNDS = ["zweite", "dritte", "vierte"]

/**
 * Vorschläge aus der Ablage selbst.
 *
 * Reihenfolge: erst was am Vorgang hängt (Fehlschläge, geänderte Dateien), dann
 * die übrigen Dateien, dann die Bereiche mit ihren Fundstellen. Alles Bekannte
 * fällt vorher heraus — abgeleitet heißt nicht wiederholt.
 *
 * Ist irgendwann alles abgearbeitet, wird der Durchgang benannt: dieselbe
 * Arbeit nach dem ersten Durchgang noch einmal anzugehen ist eine andere
 * Aufgabe als vorher — und der Lauf endet so nie ohne Vorschlag.
 */
function deriveSuggestions(input, seen, budget, round = 0) {
  const material = input ?? {}
  const suffix = round ? ` — ${DERIVE_ROUNDS[round - 1] ?? `${round + 1}.`} Durchgang` : ""
  const edited = (material.edited ?? []).filter(Boolean)
  const rest = (material.files ?? []).filter(Boolean).filter((file) => !edited.includes(file))
  const files = [...new Set([...edited, ...rest])].slice(0, 8)
  const candidates = []

  for (const failure of (material.failures ?? []).slice(0, 4)) {
    const where = failure.target ? ` auf ${failure.target}` : ""
    candidates.push({
      title: `Fehlschlag ${failure.tool}${where} beheben${suffix}`,
      detail: withKind("Absichern", `Der Aufruf ist fehlgeschlagen: ${failure.error || failure.tool}.`),
      prompt: "",
    })
  }

  for (const file of files) {
    for (const step of DERIVE_FILE_STEPS) {
      candidates.push({ title: step.title(file) + suffix, detail: withKind(step.kind, step.detail(file)), prompt: "" })
    }
  }

  for (const area of material.areas ?? []) {
    for (const sample of (area.samples ?? []).slice(0, 3)) {
      candidates.push({
        area: area.key,
        title: `${area.label}: ${sample} ausbauen${suffix}`,
        detail: withKind(
          "Erweitern",
          `${area.label} ist an ${sample} zu erkennen; der nächste Schritt baut darauf auf.`,
        ),
        prompt: "",
      })
      candidates.push({
        area: area.key,
        title: `${area.label}: ${sample} besser anbinden${suffix}`,
        detail: withKind("Erweitern", `${sample} steht in ${area.label}, ohne dass der Anschluss geregelt ist.`),
        prompt: "",
      })
    }
  }

  for (const command of (material.commands ?? []).slice(0, 3)) {
    const text = clip(String(command).trim(), 40)
    candidates.push({
      title: `Aufruf "${text}" festhalten${suffix}`,
      detail: withKind("Vertiefen", `Der Aufruf ${text} wurde von Hand ausgeführt; er wiederholt sich.`),
      prompt: "",
    })
    candidates.push({
      title: `Aufruf "${text}" in die Prüfung aufnehmen${suffix}`,
      detail: withKind("Absichern", `Was ${text} prüft, läuft noch nirgends automatisch.`),
      prompt: "",
    })
  }

  for (const manifest of (material.manifests ?? []).slice(0, 2)) {
    candidates.push({
      title: `Angaben in ${manifest} prüfen${suffix}`,
      detail: withKind("Vertiefen", `Beteiligt war ${manifest}; die Angaben sind ungeprüft.`),
      prompt: "",
    })
  }

  const fresh = freshSuggestions(candidates, seen).slice(0, budget)
  if (fresh.length || round >= DERIVE_ROUNDS.length) return fresh
  return deriveSuggestions(material, seen, budget, round + 1)
}
/**
 * Der Block, der dem Modell sagt, was es nicht wiederholen darf.
 *
 * Ohne ihn schlaegt ein Modell bei gleichem Zusammenhang gern dasselbe vor —
 * der Verlauf ist ja derselbe. Mit ihm wandert die Liste des Schon-gefragt in
 * den Auftrag. Eine leere Antwort ist keine zulaessige Antwort: wer die
 * naheliegenden Schritte verbraucht hat, geht tiefer in dieselbe Ablage.
 */
function askedBlock(seen) {
  const list = (seen ?? []).filter(Boolean)
  if (!list.length) return ""
  return [
    "",
    "BEREITS VORGESCHLAGEN (in dieser Sitzung oder für dieses Projekt — nichts davon erneut anbieten):",
    ...list.map((title) => `  - ${title}`),
    "Jeder neue Vorschlag ist eine andere Arbeit als alles oben Genannte. Derselbe Gedanke mit anderen Worten gilt als Wiederholung.",
    "Eine leere Liste oder eine Liste mit Wiederholungen ist ungültig. Sind die naheliegenden Schritte verbraucht, geh tiefer:",
    "ein anderer Aspekt derselben Sache, ein anderer Baustein, ein Rand- oder Fehlerfall, eine Alternative, der nächste Ausbauschritt.",
    "Die Belege bleiben dabei die Grundlage — tiefer heißt nicht erfunden.",
  ].join("\n")
}

/** Der Nachdruck, wenn die erste Antwort nur Bekanntes enthielt. */
function strictReminder() {
  return [
    "",
    "ACHTUNG: Deine Liste enthielt nur Vorschläge, die oben unter BEREITS VORGESCHLAGEN stehen.",
    "Das ist keine gültige Antwort. Liefere jetzt ausschließlich andere Arbeiten — andere Bausteine, andere Dateien,",
    "andere Anwendungsfälle, andere Aspekte derselben Sache. Eine leere Liste ist ebenso ungültig wie eine Wiederholung.",
  ].join("\n")
}

/** Drei Stufen, weil Modelle sich nicht zuverlässig an ein Format halten. */
function toSuggestion(item) {
  if (typeof item === "string")
    return item.trim() ? { title: clip(item.trim(), 120), detail: "", prompt: "" } : undefined
  if (!item || typeof item !== "object") return undefined
  const title = String(item.title ?? item.name ?? item.step ?? item.titel ?? "").trim()
  if (!title) return undefined
  const kind = kindOf(item.kind ?? item.lens ?? item.group ?? item.art ?? item.richtung)
  const detail = String(item.detail ?? item.reason ?? item.why ?? item.details ?? item.begruendung ?? "").trim()
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
}

/**
 * Vorschlaege aus einer abgeschnittenen Antwort retten.
 *
 * Modelle brechen bei langen Antworten mitten im Array ab; dann fehlt die
 * schliessende Klammer, und `JSON.parse` scheitert am Ganzen — obwohl die
 * einzelnen Eintraege vollstaendig dastehen. Hier wird Zeichen fuer Zeichen
 * nach vollstaendigen Objekten gesucht und jedes einzeln gelesen. Klammern in
 * Zeichenketten zaehlen dabei nicht mit.
 */
function salvageSuggestions(text) {
  const items = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      if (inString) escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "{") {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        try {
          items.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          /* einzelnes Objekt unvollstaendig */
        }
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }

  return normalizeSuggestions(items.map(toSuggestion).filter(Boolean))
}

function parseSuggestions(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return []

  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text)
  const candidate = fenced?.[1] ?? sliceBalanced(text)
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {
        const items = parsed.map(toSuggestion).filter(Boolean)
        if (items.length) return normalizeSuggestions(items)
      }
      // Manche Modelle verpacken die Liste in ein Objekt.
      if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
        for (const key of ["suggestions", "vorschlaege", "vorschläge", "items", "results"]) {
          if (!Array.isArray(parsed[key])) continue
          const items = parsed[key].map(toSuggestion).filter(Boolean)
          if (items.length) return normalizeSuggestions(items)
        }
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

  // Letzte Stufe vor dem Rohtext: eine abgebrochene Antwort retten.
  const salvaged = salvageSuggestions(text)
  if (salvaged.length) return salvaged

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
    // Der Ort muss verschachtelt unter `location` stehen: flach uebergeben
    // ignoriert der Server ihn und faellt auf sein Standardverzeichnis zurueck.
    const response = await client.file.list({ location: { directory: root }, path: path || "." })
    const entries = Array.isArray(response) ? response : (response?.data ?? [])
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

/**
 * Kennzeichen des Projektbaums, so billig wie moeglich.
 *
 * Nur die Wurzel wird aufgelistet — ein einziger Aufruf statt des ganzen
 * Spaziergangs. Aendert sich dort etwas, ist der Bericht veraltet. Aenderungen
 * tiefer im Baum deckt erst die Frist ab; das ist der bewusste Preis dafuer,
 * dass ein zweiter Lauf nichts lesen muss.
 *
 * Ohne Antwort gibt es kein Kennzeichen — dann wird neu gelesen statt geraten.
 */
async function projectSignature(client, root) {
  const entries = await listProjectDirectory(client, root, ".")
  if (!entries.length) return undefined
  return entries
    .map((entry) => `${entry?.type === "directory" ? "d" : "f"} ${String(entry?.path ?? "").replace(/\/+$/, "")}`)
    .sort()
    .join("\n")
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
          .replace(/\/+$/, "")
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
    const response = await client.file.read({ location: { directory: root }, path })
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
    variants: [
      "Oberfläche um eine neue Ansicht erweitern",
      "Oberfläche um eine bessere Rückmeldung erweitern",
      "Oberfläche um einen weiteren Bedienweg erweitern",
    ],
    lead: "Die Oberfläche besteht aus",
    tail: "Eine neue Ansicht oder ein neuer Bedienweg baut darauf auf.",
  },
  architecture: {
    kind: "Erweitern",
    title: "Architektur um einen Baustein erweitern",
    variants: [
      "Architektur um eine Schicht erweitern",
      "Architektur um eine klarere Grenze erweitern",
      "Architektur um einen weiteren Baustein erweitern",
    ],
    lead: "Die Struktur des Projekts zeigt",
    tail: "Ein neuer Baustein oder eine klarere Grenze zwischen den Teilen baut darauf auf.",
  },
}

/**
 * Die Vorlage eines Pflichtbereichs, aber ohne Wiederholung.
 *
 * Der erste freie Wortlaut gewinnt. Sind alle Varianten schon dagewesen, gibt es
 * keine Vorlage — dann bleibt der Bereich lieber leer, als denselben Vorschlag
 * ein zweites Mal zu zeigen. Ein wiederholter Vorschlag ist wertlos, auch wenn
 * er einen Pflichtbereich abdeckt.
 */
function areaTemplate(area, seen) {
  const template = AREA_TEMPLATES[area?.key]
  if (!template) return undefined
  const title = [template.title, ...(template.variants ?? [])].find((candidate) => !isRepeat(candidate, seen))
  if (!title) return undefined
  return { ...template, title }
}

/**
 * Worte, mit denen ein Bereich im Argument erkannt wird.
 *
 * Der Schluessel allein genuegt nicht: getippt wird "Gui", "Tests" oder
 * "Oberfläche", nicht "gui". Deshalb steht neben dem Schluessel die
 * Beschriftung und das, was umgangssprachlich gemeint ist.
 */
const AREA_SYNONYMS = {
  gui: [
    "gui",
    "ui",
    "oberflaeche",
    "oberfläche",
    "ansicht",
    "ansichten",
    "bedienung",
    "interface",
    "frontend",
    "fenster",
  ],
  architecture: ["architektur", "struktur", "aufbau", "schicht", "schichten", "modul", "module", "baustein", "grenzen"],
  api: ["api", "server", "backend", "endpunkt", "endpunkte", "route", "routes"],
  cli: ["cli", "kommandozeile", "konsole", "terminal", "befehl", "befehle"],
  data: ["daten", "datenbank", "schema", "schemas", "migration", "migrationen", "modell", "modelle"],
  plugins: ["plugin", "plugins", "erweiterung", "erweiterungen"],
  tests: ["test", "tests", "testing", "pruefung", "pruefungen", "abdeckung", "regression"],
  docs: ["doku", "dokumentation", "docs", "readme", "handbuch"],
  ci: ["ci", "automatisierung", "pipeline", "pipelines", "workflow", "workflows"],
  i18n: ["i18n", "uebersetzung", "uebersetzungen", "übersetzung", "übersetzungen", "sprache", "sprachen"],
  mobile: ["mobile", "android", "ios"],
  desktop: ["desktop", "electron", "tauri"],
  game: ["spiel", "game", "level", "levels", "szene", "szenen"],
}

/**
 * Liest das Argument als Bereichsangabe.
 *
 * "Gui" ist kein Bereichsschluessel, sondern ein Wort — gesucht wird deshalb
 * ueber Schluessel, Beschriftung und Synonyme. Erkannte Woerter werden zum
 * Filter, alles Uebrige bleibt Hinweis. Findet sich kein Bereich, bleibt das
 * ganze Argument reiner Hinweis wie bisher. "alle" hebt den Filter auf.
 */
function focusParts(focus) {
  if (focus && typeof focus === "object") return { hint: String(focus.hint ?? ""), areas: focus.areas ?? [] }

  const raw = String(focus ?? "").trim()
  if (!raw) return { hint: "", areas: [] }

  // Kleingeschrieben wird nur zum Vergleichen; im Text bleibt die Schreibweise
  // des Nutzers stehen.
  const tokens = raw.split(/[,;/|]|\s+/).filter(Boolean)
  const words = tokens.map((token) => token.toLowerCase().replace(/[^a-z0-9äöüß-]/g, ""))
  if (words.some((word) => ["alle", "alles", "*"].includes(word))) return { hint: "", areas: [] }

  const areas = []
  const rest = []
  for (const [index, token] of tokens.entries()) {
    const word = words[index]
    const area = word
      ? PROJECT_AREAS.find(
          (candidate) => candidate.key.toLowerCase() === word || (AREA_SYNONYMS[candidate.key] ?? []).includes(word),
        )
      : undefined
    if (!area) {
      rest.push(token)
      continue
    }
    if (!areas.some((known) => known.key === area.key)) areas.push(area)
  }
  return { hint: areas.length ? rest.join(" ") : raw, areas }
}

/** Worte, die einen Vorschlag einem Bereich zuordnen. */
const AREA_STOP_WORDS = new Set(["und", "der", "die", "das", "für", "fuer", "mit", "von", "den"])
function areaWords(area) {
  return [area.key, area.label, ...(AREA_SYNONYMS[area.key] ?? [])]
    .flatMap((word) =>
      String(word ?? "")
        .toLowerCase()
        .split(/[^a-z0-9äöüß]+/),
    )
    .filter((word) => word.length >= 3 && !AREA_STOP_WORDS.has(word))
}

/** Trifft ein Bereichswort im Text? Kurze Worte nur an der Wortgrenze, sonst reicht "enthalten". */
function mentionsArea(text, words) {
  return words.some((word) =>
    word.length >= 5 ? text.includes(word) : new RegExp(`(^|[^a-zäöüß])${word}(s|en|e)?([^a-zäöüß]|$)`).test(text),
  )
}

/**
 * Behaelt nur Vorschlaege der gefragten Bereiche.
 *
 * Zuerst zaehlt das Feld `area`, das das Modell setzen soll. Fehlt es, wird im
 * Text gesucht — sonst fiele ein passender Vorschlag heraus, nur weil das
 * Modell das Feld vergessen hat.
 */
/**
 * Behaelt nur Vorschlaege der gefragten Bereiche.
 *
 * Ein gesetzter `area`-Schluessel entscheidet: das Modell soll ihn setzen, und
 * wer ihn setzt, wird beim Wort genommen. Nur wenn er fehlt oder unbekannt ist,
 * wird im Text gesucht — sonst fiele ein passender Vorschlag heraus, nur weil
 * das Feld fehlt.
 */
function filterByAreas(suggestions, areas) {
  if (!areas.length) return suggestions
  const keys = new Set(areas.map((area) => area.key))
  const words = areas.flatMap(areaWords)
  return suggestions.filter((suggestion) => {
    const declared = suggestion?.area
    if (declared && PROJECT_AREAS.some((area) => area.key === declared)) return keys.has(declared)
    return mentionsArea(`${suggestion?.title ?? ""} ${suggestion?.detail ?? ""}`.toLowerCase(), words)
  })
}

/** Letzter Halt, wenn das Modell zum gefragten Bereich gar nichts geliefert hat. */
function areaFallback(area) {
  const where = (area.samples ?? []).slice(0, 3).join(", ")
  return {
    area: area.key,
    title: `${area.label}: nächsten Schritt ausbauen`,
    detail: withKind(
      "Erweitern",
      `${area.label} ist im Projekt${where ? ` an ${where}` : ""} zu erkennen. Der nächste Schritt erweitert genau diesen Teil.`,
    ),
    prompt: "",
  }
}

/**
 * Deckt ein Bericht die gefragten Bereiche ab?
 *
 * Ohne Filter gelesen heisst: der Bericht enthaelt Vorschlaege aus allen
 * Bereichen und deckt damit auch einen gefilterten Wunsch ab. Ein gefilterter
 * Lauf bekommt dagegen nur Vorschlaege zu seinem Bereich — der Bericht deckt
 * dann auch nur diesen ab. Wer danach breiter fragt, muss neu lesen; sonst
 * kaemen Vorschlaege aus einem Bereich heraus, nach dem nie gefragt wurde.
 */
function reportCovers(entry, keys) {
  const scope = entry?.scope ?? []
  if (!scope.length) return true
  if (!keys.length) return false
  return keys.every((key) => scope.includes(key))
}

/** Alter eines Berichts in Worten. */
function reportAge(at, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  if (minutes < 1) return "gerade eben"
  if (minutes === 1) return "vor einer Minute"
  if (minutes < 60) return `vor ${minutes} Minuten`
  const hours = Math.floor(minutes / 60)
  return hours === 1 ? "vor einer Stunde" : `vor ${hours} Stunden`
}

/**
 * Der Stand, der im Formular und im Zusammenhang der Auftraege steht.
 *
 * Sichtbar, nicht versteckt: wer Vorschlaege aus einem zwischengespeicherten
 * Bericht bekommt, soll das wissen — samt Alter.
 */
function reportStatus(entry, reused, now = Date.now()) {
  const time = new Date(entry.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
  if (!reused) return `Projektbericht: neu gelesen ${time}`
  return `Projektbericht: zwischengespeichert, aufgenommen ${time} (${reportAge(entry.at, now)})`
}

/**
 * Die Bereiche, auf die sich die Vorschlaege stuetzen duerfen.
 *
 * Ohne Filter kommen die erkannten Bereiche plus die Pflichtbereiche. Mit
 * Filter zaehlen ausschliesslich die gefragten Bereiche — sonst wuerde die
 * Pflichtregel fuer Oberflaeche und Architektur einen fremden Vorschlag
 * erzwingen und den Filter aushebeln.
 */
function selectAreas(detected, files, wanted) {
  if (!wanted.length) return ensureCoreAreas(detected, files)
  const keys = new Set(wanted)
  return ensureCoreAreas(
    detected.filter((area) => keys.has(area.key)),
    files,
    wanted,
  )
}

/**
 * Die beiden Kernbereiche gelten immer.
 *
 * Oberflaeche und Architektur sind die Bereiche, die ein Projekt am meisten
 * voranbringen — und die am leichtesten uebersehen werden, wenn die Pfade sie
 * nicht verraten (ein flaches Projekt hat kein `components/` und kein
 * `packages/`). Deshalb werden sie ergaenzt, wenn die Erkennung sie nicht
 * findet; als Belege dienen dann die sprechendsten vorhandenen Dateien.
 */
function ensureCoreAreas(areas, files, required = ["gui", "architecture"]) {
  const result = [...areas]
  for (const key of required) {
    if (result.some((area) => area.key === key)) continue
    const definition = PROJECT_AREAS.find((area) => area.key === key)
    if (!definition) continue
    const samples = files
      .filter((path) => !PROJECT_SKIP_FILE.test(path))
      .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))
      .slice(0, 3)
    result.push({ ...definition, samples: samples.length ? samples : ["(kein sprechender Pfad gefunden)"] })
  }
  return result
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
function ensureAreaSuggestions(suggestions, areas, budget, seen) {
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
    const template = areaTemplate(area, seen)
    if (!template) continue
    guaranteed.push({
      area: area.key,
      title: template.title,
      detail: withKind(template.kind, `${template.lead} ${(area.samples ?? []).join(", ")}. ${template.tail}`),
      prompt: "",
    })
  }

  if (!guaranteed.length) return list.slice(0, budget)

  // Fuer die Pflichtbereiche wird Platz freigehalten; das Modell darf sie nicht
  // verdraengen. Der Rest behaelt seine Reihenfolge.
  return [...list.slice(0, Math.max(0, budget - guaranteed.length)), ...guaranteed].slice(0, budget)
}

function buildProjectPrompt(root, analysis, keyFiles, focus, limits, seen) {
  const { hint, areas } = focusParts(focus)
  const scope = areas.length ? areas.map((area) => `${area.label} (area "${area.key}")`).join(", ") : ""
  const size = limits ?? PROJECT_LIMITS
  return [
    "AUFGABE: Verschaffe dir einen Überblick über dieses Projekt und schlage danach die nächsten Arbeiten vor.",
    'Antworte ausschließlich mit einem JSON-Objekt der Form {"summary":"…","suggestions":[…]}, ohne Codezaun, ohne Vorwort.',
    "`summary` ordnet das Projekt in 4 bis 8 Sätzen ein: wozu es dient, wie es aufgebaut ist, welche Technik es nutzt, wie weit es ist und was offensichtlich fehlt.",
    "`suggestions` ist ein Array mit höchstens " +
      MAX_SUGGESTIONS +
      " Einträgen, jeweils {kind, title, detail, prompt, area}.",
    scope
      ? `Pflichtregel zu den Bereichen: Es kommen ausschließlich Vorschläge zu diesen Bereichen: ${scope}. Jeder Vorschlag trägt genau einen dieser Schlüssel als \`area\`; Vorschläge zu anderen Bereichen sind falsch, auch wenn sie wichtig erscheinen. Alle Vorschläge gehören zu diesen Bereichen — nicht nur der erste.`
      : `Pflichtregel zu den Bereichen: Für jeden Bereich, der unten als Pflichtvorschlag steht, gehört genau ein Vorschlag dazu, der diesen Bereich erweitert. Für die übrigen erkannten Bereiche gilt: mindestens einer, solange die Ablage Belege hergibt.`,
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
    'Die Mehrheit der Vorschläge sind "Erweitern": mindestens die Hälfte, ab sechs Vorschlägen mindestens zwei Drittel.',
    'Ein "Erweitern"-Vorschlag ist ein vollständiges Feature, kein Detail: eine neue Funktion, eine neue Ansicht, ein neuer Modus, ein neuer Befehl, eine neue Auswertung, eine neue Automatik oder ein neuer Anwendungsfall — und er verbessert die Nutzung.',
    "Erfinde nichts. Sind die naheliegenden Schritte verbraucht, geh tiefer in dieselbe Ablage (anderer Aspekt, anderer Baustein, Rand- oder Fehlerfall, nächster Ausbauschritt), statt weniger oder gar nichts zu liefern — eine leere Liste ist ungültig.",
    scope ? `${hint ? `Zusätzlich im Blick: ${hint}` : ""}` : hint ? `Besonderes Augenmerk: ${hint}` : "",
    "",
    askedBlock(seen),
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

    /**
     * Das Projektverzeichnis dieser Session.
     *
     * Zuerst die Session selbst: nur sie weiss, in welchem Verzeichnis sie
     * laeuft. Die lokalen Werte sind nur Rueckfall — sie zeigen sonst auf das
     * Verzeichnis, aus dem opencode gestartet wurde.
     */
    const sessionDirectory = async (sessionID) => {
      try {
        const response = await client.session.get({ sessionID })
        const info = response?.data ?? response
        const directory = info?.location?.directory ?? info?.directory
        if (directory) return directory
      } catch {
        /* naechste Quelle */
      }
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
        // Kein Leerlauf: ohne Belege aus dieser Sitzung wird das Projekt
        // gelesen. Die Sitzung kennt ihr Verzeichnis, also gibt es dort etwas.
        toast("Keine Belege in dieser Sitzung — lese stattdessen das Projekt", "info")
        return await askProject(sessionID, focus)
      }
      // Ein Argument, das einen Bereich benennt, wird zum Filter.
      const scope = focusParts(focus)

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

        // Was diese Sitzung schon gesehen hat, wird nicht noch einmal gezeigt.
        const keys = [`session:${sessionID}`]
        const seen = askedFor(keys)

        // In langen Sessions scheitert die Anfrage mitunter (etwa ein 502 des
        // Anbieters). Dann darf der Befehl nicht ins Leere laufen: es gibt
        // Vorschlaege aus den Belegen.
        const askModel = async (strict) => {
          try {
            return await client.session.generate({
              sessionID,
              prompt: buildPrompt(evidence, focus, seen) + (strict ? strictReminder() : ""),
            })
          } catch (cause) {
            toast(`Modell nicht erreichbar (${cause?.message ?? cause}) — Vorschläge aus den Belegen`, "warning")
            return undefined
          }
        }

        const budget = scope.areas.length
          ? Math.min(suggestionBudget(evidence), FILTER_SUGGESTIONS)
          : suggestionBudget(evidence)
        const parseListed = (response) =>
          (response ? parseSuggestions(response?.text ?? response) : []).slice(0, budget)

        let generated = await askModel(false)
        let fresh = freshSuggestions(parseListed(generated), seen)
        if (generated && seen.length && !fresh.length) {
          toast("Antwort nur mit Bekanntem — frage mit Nachdruck nach anderen", "info")
          generated = await askModel(true)
          fresh = freshSuggestions(parseListed(generated), seen)
        }
        // Bringt das Modell nur Bekanntes — sei es, weil es nicht geantwortet hat,
        // sei es, weil es sich wiederholt hat —, gilt der Rest aus den Belegen.
        // Auch der muss neu sein; reicht auch das nicht, wird aus der Ablage
        // selbst abgeleitet. Ein Lauf endet nie ohne Vorschlaege.
        if (!fresh.length) fresh = freshSuggestions(fallbackSuggestions(evidence), seen)
        if (!fresh.length) {
          fresh = deriveSuggestions(
            {
              edited: evidence.edited,
              files: [
                ...(evidence.code ?? []),
                ...(evidence.readOnly ?? []),
                ...(evidence.tests ?? []),
                ...(evidence.docs ?? []),
              ],
              failures: evidence.failures,
              manifests: evidence.manifests,
              commands: evidence.commands,
            },
            seen,
            budget,
          )
        }

        // Zweite, belegbasierte Bremse: das Modell darf sich an der Obergrenze
        // nicht vorbeireden. Mit Filter zaehlt zusaetzlich nur der gefragte
        // Bereich — und wenn dazu nichts kam, greift der Bereich selbst.
        const filtered = filterByAreas(fresh, scope.areas)
        const chosen =
          filtered.length || !scope.areas.length ? filtered : freshSuggestions(scope.areas.map(areaFallback), seen)
        const suggestions = technicalOnly(chosen, evidence)

        if (scope.areas.length) {
          toast(
            `${scope.areas.map((area) => area.label).join(", ")}: ${suggestions.length} von ${parseListed(generated).length} Vorschlägen`,
            "info",
          )
        }

        if (!suggestions.length) {
          // Letzter Halt gegen einen leeren Lauf: das Projekt heranziehen. Die
          // Sitzung kennt ihr Verzeichnis, dort gibt es fast immer etwas.
          pending = false
          toast("Im Verlauf ist nichts Greifbares — lese stattdessen das Projekt", "info")
          return await askProject(sessionID, focus)
        }

        const base = evidence.mode === "Umsetzen" ? "Was als Nächstes? — auch abseits vom Faden" : "Was als Nächstes?"
        const title = scope.areas.length
          ? `${scope.areas.map((area) => area.label).join(", ")}: was als Nächstes? (${suggestions.length})`
          : `${base} (${suggestions.length})`

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
        // Gezeigt heisst gemerkt: beim naechsten Mal kommt nichts davon wieder.
        rememberAsked(keys, suggestions)
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
     * Ein Versuch beim Modell fuer den Projektbericht.
     *
     * Scheitert er am Umfang (der Anbieter antwortet etwa mit 502), wird einmal
     * kleiner nachgefasst: ein groeberer Ueberblick ist besser als keiner.
     * `strict` haengt den Nachdruck an, wenn die erste Antwort nur Bekanntes
     * enthielt.
     */
    const projectReport = async (client, sessionID, root, analysis, keyFiles, focus, seen, strict) => {
      const reminder = strict ? strictReminder() : ""
      try {
        return await client.session.generate({
          sessionID,
          prompt: buildProjectPrompt(root, analysis, keyFiles, focus, undefined, seen) + reminder,
        })
      } catch (cause) {
        toast(`Erster Versuch zu groß (${cause?.message ?? cause}) — noch einmal kompakt`, "warning")
        try {
          return await client.session.generate({
            sessionID,
            prompt: buildProjectPrompt(root, analysis, keyFiles, focus, PROJECT_COMPACT, seen) + reminder,
          })
        } catch (again) {
          toast(`Modell nicht erreichbar (${again?.message ?? again}) — Vorschläge aus dem Projekt`, "warning")
          return undefined
        }
      }
    }

    /**
     * Formular und Auftraege aus einem fertigen Projektbericht.
     *
     * Gilt fuer den frisch gelesenen und den zwischengespeicherten Bericht —
     * nur die Vorschlaege und der Vermerk ueber den Stand unterscheiden sich.
     * Der Filter wird nachgehalten, nicht erhofft: was nicht zum gefragten
     * Bereich gehoert, faellt heraus. Dazu die harte Regel: nichts, was in
     * dieser Sitzung oder fuer dieses Projekt schon einmal angeboten wurde,
     * kommt ein zweites Mal. Reicht der Bericht nicht, wird aus der Ablage
     * abgeleitet — ein Lauf endet nie ohne Vorschlaege.
     */
    async function offerProject(sessionID, input) {
      const { root, analysis, listed, summary, evidence, scope, status, seen, keys } = input
      const scopeKeys = scope.areas.map((area) => area.key)
      const areas = selectAreas(analysis?.areas ?? [], analysis?.files ?? [], scopeKeys)
      const budget = scopeKeys.length
        ? Math.min(suggestionBudget(evidence), FILTER_SUGGESTIONS)
        : suggestionBudget(evidence)
      const fresh = freshSuggestions(listed, seen)
      const filtered = filterByAreas(fresh, scope.areas)
      // Reicht der Bericht nicht, wird aus dem Baum abgeleitet: je Datei und je
      // Bereich eine andere Arbeit. Damit bleibt kein Lauf ohne Vorschlag.
      const derived = filterByAreas(
        deriveSuggestions(
          {
            edited: evidence.edited,
            files: analysis?.files ?? [],
            failures: evidence.failures,
            manifests: evidence.manifests,
            commands: evidence.commands,
            areas,
          },
          seen,
          budget,
        ),
        scope.areas,
      )
      const fallback = freshSuggestions(
        scopeKeys
          .map((key) => areas.find((area) => area.key === key) ?? scope.areas.find((area) => area.key === key))
          .filter(Boolean)
          .map(areaFallback),
        seen,
      )
      const suggestions = ensureAreaSuggestions(
        filtered.length ? filtered : [...derived, ...fallback],
        areas,
        budget,
        seen,
      ).slice(0, MAX_SUGGESTIONS)

      if (scopeKeys.length) {
        toast(
          `${scope.areas.map((area) => area.label).join(", ")}: ${suggestions.length} von ${listed.length} Vorschlägen`,
          "info",
        )
      }
      if (!suggestions.length) {
        // Kann nur eintreten, wenn der Baum keine einzige lesbare Datei hat;
        // das faengt schon die Pruefung nach dem Lesen ab.
        toast("Ohne Anknüpfungspunkt im Baum lässt sich nichts begründen", "warning")
        return true
      }
      if (seen?.length && !fresh.length) {
        toast(`Aus dem Bericht abgeleitet: ${suggestions.length} weitere Vorschläge`, "info")
      }

      const count = analysis?.count ?? 0
      const extra = [
        `Projektverzeichnis: ${root}`,
        `Gelesene Projektdateien: ${count}`,
        scopeKeys.length ? `Gefragter Bereich: ${scope.areas.map((area) => area.label).join(", ")}` : "",
        status,
        summary ? `Projektübersicht: ${summary}` : "",
      ].filter(Boolean)

      const formID = await openSuggestionForm(sessionID, {
        suggestions,
        title: scopeKeys.length
          ? `${scope.areas.map((area) => area.label).join(", ")} — nächste Schritte (${suggestions.length})`
          : `Nächste Schritte im Projekt (${suggestions.length})`,
        // Der Stand gehoert sichtbar ins Formular: wer Vorschlaege aus einem
        // zwischengespeicherten Bericht bekommt, soll das wissen.
        message: [status, summary ? clip(summary, 400) : `Projektüberblick über ${count} Dateien`]
          .filter(Boolean)
          .join("\n"),
      })
      if (!formID) return false

      const sole = (await keepSoleForm(client, sessionID, INSTANCE_ID)) ?? { id: formID, owned: true, removed: 0 }
      if (!sole.owned) return true
      // Gezeigt heisst gemerkt: erst wenn dieses Formular stehen bleibt, gilt die
      // Liste als angeboten. So kann sie kein zweites Mal auftauchen.
      rememberAsked(keys ?? [], suggestions)
      await submitSelection(sessionID, sole, suggestions, evidence, extra)
      return true
    }

    /**
     * Vorschlaege aus dem ganzen Projekt statt nur aus dieser Session.
     *
     * Einmal lesen, mehrfach nutzen: der Bericht des letzten Laufs wird
     * innerhalb der Frist wiederverwendet, solange das Kennzeichen des Baums
     * stimmt und der Bericht den gefragten Bereich abdeckt. Dann wird nur noch
     * gefiltert — Baum, Schluesseldateien und Merkmale bleiben ungelesen.
     * Sonst wird gelesen wie bisher: erst der Baum, dann die Schluesseldateien,
     * dann die Merkmale, jeder Schritt mit Fortschritt.
     */
    async function askProject(sessionID, focus) {
      if (pending || !sessionID) return false

      const root = await sessionDirectory(sessionID)
      if (!root) {
        toast("Kein Projektverzeichnis gefunden", "warning")
        return false
      }

      const { evidence } = readEvidence(sessionID)
      // Ein Argument, das einen Bereich benennt, wird zum Filter: dann kommen
      // ausschliesslich Vorschlaege dieses Bereichs. Alles andere bleibt Hinweis.
      const scope = focusParts(focus)
      const scopeKeys = scope.areas.map((area) => area.key)
      // Gemerkt wird je Sitzung und je Projektverzeichnis: ein Vorschlag, den
      // diese Sitzung schon gesehen hat, kommt nicht wieder — und einer, den es
      // fuer dieses Projekt schon gab, ebenso wenig.
      const keys = [`session:${sessionID}`, `project:${root}`]
      const seen = askedFor(keys)
      pending = true
      try {
        // Wiederverwenden, wenn der Bericht jung genug ist, den gefragten
        // Bereich abdeckt und der Baum unveraendert steht. Geprueft wird nur die
        // Wurzel: ein Aufruf statt des ganzen Spaziergangs. Aus dem Bericht kommt
        // aber nur, was noch nicht dran war — ist er abgegrast, wird gelesen und
        // neu gefragt.
        const cached = readProjectReport?.(root)
        if (cached && Date.now() - cached.at <= PROJECT_REPORT_TTL_MS && reportCovers(cached, scopeKeys)) {
          const signature = await projectSignature(client, root)
          if (signature !== undefined && signature === cached.signature) {
            const listed = technicalOnly(cached.suggestions ?? [], evidence)
            // Wiederverwenden nur, wenn der Bericht fuer den gefragten Bereich
            // noch etwas hergibt, das nicht schon gezeigt wurde. Sonst wird
            // gelesen und neu gefragt — ein zweites Mal dasselbe gibt es nicht.
            if (freshSuggestions(filterByAreas(listed, scope.areas), seen).length) {
              toast(`Projektbericht wiederverwendet (${reportAge(cached.at)}) — ${root}`, "info")
              note({ action: "report", sessionID, root, reused: true, at: cached.at })
              return await offerProject(sessionID, {
                root,
                analysis: cached.analysis,
                listed,
                summary: cached.summary,
                evidence,
                scope,
                status: reportStatus(cached, true),
                seen,
                keys,
              })
            }
            toast("Bericht ausgeschöpft — frage das Modell nach weiteren Vorschlägen", "info")
          }
        }

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

        // Erster Versuch mit der Liste des Schon-gefragt. Kommt nur Bekanntes
        // zurueck, wird einmal mit Nachdruck nachgefragt — danach ist Schluss.
        let generated = await projectReport(client, sessionID, root, analysis, keyFiles, focus, seen)
        let report = generated ? parseProjectReport(generated?.text ?? generated) : { summary: "", suggestions: [] }
        if (generated && seen.length && !freshSuggestions(report.suggestions, seen).length) {
          toast("Antwort nur mit Bekanntem — frage mit Nachdruck nach anderen", "info")
          generated = await projectReport(client, sessionID, root, analysis, keyFiles, focus, seen, true)
          if (generated) report = parseProjectReport(generated?.text ?? generated)
        }

        const listed = technicalOnly(
          report.suggestions.length ? report.suggestions : projectFallback(files, evidence),
          evidence,
        )
        // Hat das Modell nur Bekanntes geliefert, kommt dazu, was die Ablage
        // selbst hergibt — sonst bliebe der Lauf leer, obwohl es belegte
        // Schritte gibt, die noch nicht dran waren.
        const topped =
          freshSuggestions(listed, seen).length || !seen.length
            ? listed
            : technicalOnly([...listed, ...projectFallback(files, evidence)], evidence)

        // Bericht ablegen, damit der naechste Lauf nicht wieder liest. Nur mit
        // gueltigem Kennzeichen: ohne Kennzeichen waere er nicht pruefbar und
        // damit wertlos. Abgelegt wird die volle Liste; das Aussortieren des
        // Schon-gefragt passiert erst beim Zeigen, sonst waere der Bericht nach
        // einem einzigen Lauf verbraucht.
        const signature = await projectSignature(client, root)
        if (signature !== undefined) {
          await writeProjectReport?.({
            directory: root,
            at: Date.now(),
            signature,
            scope: scopeKeys,
            summary: report.summary,
            suggestions: topped,
            analysis,
          })
          note({ action: "report", sessionID, root, reused: false, files: files.length })
        }

        return await offerProject(sessionID, {
          root,
          analysis,
          listed: topped,
          summary: report.summary,
          evidence,
          scope,
          status: reportStatus({ at: Date.now() }, false),
          seen,
          keys,
        })
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

    // Zwischenspeicher fuer den Projektbericht. Er liegt neben der Spur (eigener
    // Schluessel, eigene Datei) und haelt je Projektverzeichnis den zuletzt
    // gelesenen Bericht samt Kennzeichen des Baums.
    let readProjectReport
    let writeProjectReport
    try {
      const [reports, updateReports] = storage.store("project-report", { initial: { entries: [] } })
      readProjectReport = (directory) => (reports.entries ?? []).find((entry) => entry?.directory === directory)
      writeProjectReport = (entry) =>
        updateReports((draft) => {
          draft.entries = [entry, ...(draft.entries ?? []).filter((item) => item?.directory !== entry.directory)].slice(
            0,
            PROJECT_REPORT_MAX,
          )
        })
    } catch {
      /* ohne Ablage kein Zwischenspeicher: dann wird eben jedes Mal gelesen */
    }

    // Was schon vorgeschlagen wurde. Je Sitzung und je Projektverzeichnis eine
    // Liste der gezeigten Titel: derselbe Vorschlag kommt kein zweites Mal.
    let readAsked
    let writeAsked
    try {
      const [asked, updateAsked] = storage.store("asked", { initial: { entries: [] } })
      readAsked = (key) => (asked.entries ?? []).find((entry) => entry?.key === key)?.titles ?? []
      writeAsked = (key, titles) =>
        updateAsked((draft) => {
          const others = (draft.entries ?? []).filter((entry) => entry?.key !== key)
          draft.entries = [{ key, titles: [...titles].slice(-ASKED_MAX), at: Date.now() }, ...others]
            .sort((left, right) => (right?.at ?? 0) - (left?.at ?? 0))
            .slice(0, ASKED_KEYS)
        })
    } catch {
      /* ohne Ablage wird eben nichts gemerkt: dann kann es Wiederholungen geben */
    }

    /** Alle Titel, die in diesen Schluesseln schon gezeigt wurden. */
    const askedFor = (keys) => {
      const titles = []
      for (const key of keys) {
        for (const title of readAsked?.(key) ?? []) if (!titles.includes(title)) titles.push(title)
      }
      return titles
    }

    /** Die gezeigten Titel merken — je Sitzung und je Projektverzeichnis. */
    const rememberAsked = (keys, suggestions) => {
      const titles = (suggestions ?? []).map((suggestion) => String(suggestion?.title ?? "").trim()).filter(Boolean)
      if (!writeAsked || !titles.length) return
      for (const key of keys) {
        const merged = [...askedFor([key])]
        for (const title of titles) if (!merged.includes(title)) merged.push(title)
        void Promise.resolve(writeAsked(key, merged)).catch(() => undefined)
      }
    }

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
