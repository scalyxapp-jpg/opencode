# auto-suggest (Plugin)

Schlägt nach abgeschlossenen Schritten nächste Arbeiten vor, gestützt auf die
Tool-Aufrufe der laufenden Session.

## Installation

Als Verzeichnis unter `<config>/plugins/` ablegen:

```
~/.config/opencode/plugins/auto-suggest/tui.js
```

**Kein `package.json` in das Verzeichnis legen.** Der Host löst den
Server-Einstieg über den Verzeichnis-Default auf; mit `"main": "tui.js"` würde
dieselbe Datei auch als Server-Plugin geladen und der Befehl erscheint nie.

## Benutzung

```
/next              Vorschläge anfragen
/next <fokus>      mit besonderem Augenmerk
/next <Bereich>    nur dieser Bereich
```

Auch `/next` versteht das Bereichsargument als Filter (`/next Tests`). Die
Bereiche stehen bei `/nextProject` beschrieben.

Die Vorschläge erscheinen als **Formular inline im Verlauf** — dieselbe
Darstellung wie eine Frage des question-Tools, mit nummerierter Liste, Kästchen
zum Anhaken, Beschreibungen und dem Hinweis
`⇆ tab ↑↓ select enter toggle esc dismiss`.
Kein Overlay-Fenster.

**Bedienung:** `↑↓` wählt, `enter`/`space` hakt an, `tab` und `enter` übernehmen
die angehakten Vorschläge, `esc` verwirft.

Werden mehrere Vorschläge angehakt, wird **je Auswahl ein eigener Auftrag**
abgeschickt: der erste startet den Lauf, die weiteren warten in der
Warteschlange und kommen als eigene Turns dran. Jeder Auftrag ist als Teil einer
Reihe gekennzeichnet („Aufgabe 1 von 2 — eigenständig“) und trägt am Ende einen
Rahmen: nur diese eine Aufgabe bearbeiten, abschließen, die weiteren nicht
vorab beginnen und nicht vermischen. So versteht der Agent, dass es getrennte
Arbeiten sind und nicht ein großes Vorhaben.

**Nie die blosse Vorschlagszeile.** Ein Vorschlag ist eine Überschrift, kein
Auftrag — wer nur ihn in den Chat schreibt, überlässt dem Agenten das Raten. Das
Modell schreibt deshalb zu jedem Vorschlag ein Feld `prompt` (s. `buildPrompt`):
mehrere Sätze, für sich verständlich, mit Ziel, betroffenen Dateien und der
Frage, woran die Fertigstellung zu erkennen ist. `composeTask` hängt zusätzlich
einen belegten Abschnitt „Zusammenhang aus dieser Session“ an (Arbeitsmodus,
Verzeichnis, geänderte und gelesene Dateien, Befehle, Fehlschläge, letzte
Anfragen, Lücken). Fehlt das Feld `prompt`, greift eine Vorlage, die das Ziel
nennt und zum Nachlesen im Code auffordert — der Zusammenhang kommt trotzdem
mit.

### Wache gegen unangeforderte Formulare

Weil Vorschläge nur über `/next` kommen dürfen, prüft eine Wache alle zwei
Sekunden, ob ein Vorschlagsformular **ohne** Anforderungsmarke offen ist
(`metadata.requested`), und schließt es. Das greift auch dann, wenn im laufenden
Prozess noch ein Zuhörer aus einer älteren Fassung steckt, der von sich aus
Formulare anlegt. Ohne offene Formulare kostet die Wache nichts: erst wenn die
Sitzungsliste ein Formular meldet, wird der Server gefragt.

Der Auftrag wird **direkt abgeschickt**. Externe Plugins bekommen den
Composer nicht zu sehen (`ui` hat keinen Prompt-Setter), deshalb gibt es keinen
Weg, ihn nur einzufügen.

Das Feld ist eine **Mehrfachauswahl** (`multiselect` mit `minItems: 1`), damit
mehrere Vorschläge auf einmal übernommen werden können; ausgewählt wird mit
`enter`/`space`, übernommen mit `tab` und `enter`. Nur bei diesem Feldtyp
wirken `minItems`/`maxItems`, und nur bei ihm kommt die Antwort als Liste
zurück. Der Einzelauswahl-Typ `string` mit `options` erlaubt das nicht.

Weil `single()` in der TUI nur für `boolean` oder `string` **mit** `options`
wahr wird, ist die Reiterzeile hier sichtbar — sie zeigt `formLabel(field)`.
Damit das Label trotzdem nicht doppelt erscheint, trägt der Feldkopf einen
Hinweis: gerendert wird `description ?? formLabel(field)`, also der Hinweis
statt des Titels.

Zur Nachvollziehbarkeit schreibt das Plugin bei jedem Anlegen einen Eintrag nach
`<state>/<channel>/tui/plugin.auto-suggest.diagnostics.json` (die letzten 60):
Instanz, Formular und Anzahl der Vorschläge.

Warum das Feld keine Texteingabe wird: `formTextual(field)` in
`packages/tui/src/util/form.ts` ist nur für `number`/`integer` oder `string`
**ohne** `options` wahr. `formCustom(field)` bleibt ohne `custom: true` falsch,
es gibt also auch keinen Freitext-Eintrag. `formRows(field)` liefert die
Optionsliste.

`id` beim Anlegen ist nur eine optionale Kennung; Titel und Felder stehen auf
oberster Ebene. Anders gelesen scheitert der Aufruf mit
`Expected string | null at ["id"]`.

### Projektmodus: `/nextProject`

```
/nextProject              Vorschläge aus dem ganzen Projekt
/nextProject <fokus>      mit besonderem Augenmerk
/nextProject <Bereich>    nur dieser Bereich
```

**Das Argument als Filter.** Nennt das Argument einen Bereich, wird es zum
strengen Filter — es kommen ausschließlich Vorschläge dieses Bereichs:

```
/nextProject Gui          nur Oberfläche
/nextProject Tests        nur Tests
/nextProject gui, tests   nur Oberfläche und Tests
/nextProject Barrierefreiheit   freier Hinweis wie bisher
```

Erkannt werden Schlüssel, Beschriftung und Umgangssprache: `Gui`, `UI`,
`Oberfläche`, `Ansicht`, `Architektur`, `Struktur`, `API`, `Server`, `CLI`,
`Kommandozeile`, `Daten`, `Schema`, `Plugins`, `Tests`, `Doku`, `CI`, `i18n`,
`Mobile`, `Desktop`, `Spiel`. `alle` hebt den Filter auf.

Damit der Filter hält, greifen drei Stellen zusammen:

1. **Der Auftrag** ersetzt die Regel zu den Pflichtbereichen durch die
   Bereichsangabe und verlangt im JSON zusätzlich ein `area`-Feld.
2. **`selectAreas`** gibt nur die gefragten Bereiche weiter. Sonst würde die
   Pflichtregel für Oberfläche und Architektur einen fremden Vorschlag
   erzwingen und den Filter aushebeln.
3. **`filterByAreas`** wirft danach alles weg, was nicht dazugehört. Ein
   gesetztes `area`-Feld entscheidet; fehlt es oder ist es unbekannt, wird im
   Text gesucht (kurze Wörter wie `cli` nur an der Wortgrenze, damit `Client`
   nicht als Kommandozeile durchgeht).

Ein gefilterter Lauf fragt höchstens fünf Vorschläge ab — mehr wären
Wiederholungen mit anderem Wortlaut. Liefert das Modell zum Bereich nichts,
bleibt ein Vorschlag aus dem Bereich selbst (`areaFallback`); ein fremder
Vorschlag wäre die falsche Antwort auf die Frage.

Liest das Projekt ab dem Verzeichnis der Session — verzeichnisweise, ohne
`node_modules`, `.git`, `dist` und Ähnliches, ohne Binärdateien, begrenzt auf
160 Verzeichnisse, 500 Dateien und Tiefe 8. Danach werden die zehn Dateien
gelesen, die über das Projekt am meisten sagen (README, AGENTS, Manifeste,
Dockerfile, …), jede gekürzt. Erst der Baum, dann die Schlüsseldateien: jede
Stufe meldet ihren Fortschritt als Hinweis, weil das dauern kann.

Das Modell bekommt Baum und Auszüge und antwortet mit einer Übersicht und den
Vorschlägen (dieselbe Form wie sonst, zusätzlich `summary`). Die Übersicht steht
im Formular (als `metadata.message`) und wandert zusätzlich in den
Zusammenhang jedes Auftrags, damit der Agent weiß, worauf er sich bezieht.
Scheitert die Abfrage, greifen wie bei `/next` die belegbasierten Vorschläge.

### Der Projektbericht wird zwischengespeichert

Der Bericht wird neben der Spur abgelegt (`plugin.auto-suggest.project-report.json`,
eigener Schlüssel `project-report`, höchstens vier Berichte — einer je
Projektverzeichnis). Er enthält das Verzeichnis, die Aufnahmezeit, das
Kennzeichen des Baums, den gefragten Bereich, die Übersicht des Modells, die
Vorschläge und den vollständigen Bericht aus `analyzeProject`.

Ein zweiter Lauf innerhalb von **fünf Minuten** liest nichts mehr: er
verwendet den Bericht und filtert ihn nur noch nach dem mitgegebenen Bereich.
Übersprungen werden der ganze Baumspaziergang (bis zu 160 Verzeichnisse, 500
Dateien), die Schlüsseldateien und die Merkmale aus den Quellen — und die
Abfrage beim Modell. Es bleibt **ein einziger Aufruf**: die Wurzel des Projekts
wird aufgelistet, um zu sehen, ob der Baum noch steht.

Neu gelesen wird, wenn

- kein Bericht vorliegt,
- die Frist abgelaufen ist (fünf Minuten),
- das Kennzeichen des Baums nicht mehr stimmt (etwas in der Wurzel ist
  hinzugekommen, umbenannt oder weggefallen),
- der Bericht den gefragten Bereich nicht abdeckt. Ein Lauf **ohne** Filter
  deckt jeden Bereich ab; ein Lauf **mit** Filter deckt nur seinen eigenen ab —
  wer danach breiter fragt, liest neu, statt Vorschläge aus einem Bereich
  vorzulegen, nach dem nie gefragt wurde.

Der Stand ist sichtbar, nicht versteckt: das Formular trägt über der Übersicht
`Projektbericht: neu gelesen 14:32` oder
`Projektbericht: zwischengespeichert, aufgenommen 14:32 (vor 3 Minuten)`, und
dieselbe Zeile steht im Zusammenhang jedes abgeschickten Auftrags.

Was das nicht leistet: geprüft wird nur die Wurzel, nicht der ganze Baum.
Änderungen tief in der Ablage erkennt erst die Frist — das ist der bewusste
Preis dafür, dass ein zweiter Lauf gar nichts lesen muss. Wer sichergehen will,
wartet die fünf Minuten ab oder ruft nach einer Änderung einmal neu auf.

### Es öffnet sich nichts von selbst

Vorschläge kommen **ausschließlich** über `/next` (oder den Befehl
`session.suggest` in der Palette). Das ist eine bewusste Entscheidung: ein
Ereignis wie `session.execution.succeeded` kann nicht beurteilen, ob ein
Vorschlag gerade passt, und mehrere Faktoren haben dafür gesorgt, dass die
Auswahl mehrfach hintereinander aufging — mehrere offene Fenster (jedes mit
eigener Plugin-Instanz und eigenem Zuhörer), Hot-Reloads, und Formulare, die
serverseitig liegen blieben.

Deshalb gibt es **keine Ereignis-Abonnements** mehr. `setup()` registriert nur
noch das Kommando; es gibt nichts abzumelden und nichts, was im Hintergrund
Runden auslösen kann.

### Es gibt genau ein Formular — nicht mehrere

Ein unbeantwortetes Formular bleibt serverseitig offen, und die Oberfläche zeigt
immer das **älteste**. Ohne Aufräumen sammelt sich deshalb eines nach dem
anderen an: `esc` schließt dann zwar eines, aber an seiner Stelle erscheint
sofort das nächste gleich aussehende — es wirkt, als ließe sich die Auswahl
überhaupt nicht schließen.

Dagegen drei Vorkehrungen:

- **Erst nachsehen, dann anlegen.** Vor jedem Anlegen wird geprüft, ob schon ein
  Vorschlagsformular offen ist; dann wird **dieses benutzt** statt ein zweites
  daneben zu legen. Es wird dabei nicht geschlossen und neu erzeugt — das würde
  bei mehreren Fenstern zum ständigen Ersetzen führen.
- **Doppelgänger werden weggeräumt** (`keepSoleForm`, erkannt am Feldschlüssel
  `next`). Es bleibt das älteste stehen, weil die Oberfläche genau das zeigt und
  sein Ersteller darauf wartet. Fremde Formulare — etwa Berechtigungsabfragen —
  bleiben unangetastet.
- **Nur der Ersteller wartet und sendet ab.** Jedes Formular trägt in den
  Metadaten eine Besitzerkennung (`autoSuggestOwner`). Fragen zwei Fenster
  gleichzeitig, bleibt ein Formular stehen und nur dessen Ersteller schickt die
  Auswahl ab; wer verloren hat, steigt sofort aus. So kann dieselbe Auswahl nicht
  zweimal rausgehen — und es hängt niemand an einem Formular, das ihm nicht
  gehört.
- **Zeitablauf räumt selbst weg.** Läuft die Wartezeit von zehn Minuten ab, ohne
  dass jemand antwortet, wird das Formular abgebrochen (`waitForAnswer`) und
  bleibt nicht liegen.

## Woraus die Vorschläge entstehen

Das Plugin liest die Nachrichten der laufenden Session und verdichtet sie zu
Belegen. Es liest **beide Seiten**: die letzten vier Anfragen des Nutzers
(wörtlich) und die Werkzeugaufrufe des Assistenten.

| Beleg                | Quelle                                                       |
| -------------------- | ------------------------------------------------------------ |
| Geänderte Dateien    | `edit`, `write`, `patch`                                     |
| Nur gelesene Dateien | `read`, `glob`, `grep` — sofern später nicht geändert        |
| Tests im Spiel       | Namen mit `test`/`spec` (`_test.go`, `Test*.java`, `*.spec`) |
| Dokumentation        | geänderte `.md`, `.mdx`, `.rst`, `.txt`                      |
| Abhängigkeiten       | `package.json`, `Cargo.toml`, `go.mod`, `build.gradle`, …    |
| Befehle              | `bash`, `shell`                                              |
| Fehlschläge          | Aufrufe, die mit einem Fehler endeten                        |
| Plan                 | `todowrite`, `todoread`, `task`                              |

Daraus leitet es einen **Arbeitsmodus** ab — `Fehlersuche`, `Prüfen`,
`Dokumentieren`, `Umsetzen` oder `Erkunden` — und **beobachtete Lücken**, etwa
„Code wurde geändert, aber keine Testdatei angefasst“ oder „Es wurde geändert,
aber kein Befehl ausgeführt — nichts verifiziert“. Das Arbeitsverzeichnis
bestimmt es aus dem gemeinsamen Elternpfad der belegten Dateien.

## Vier Richtungen statt einem Faden

Das Modell soll **nicht** stumpf den Faden fortsetzen. Der Schwerpunkt liegt auf
dem **Ausbau**; Absicherung ist die Ausnahme. Jeder Vorschlag trägt eine
Richtung, die vorn im Detail steht — in dieser Rangfolge:

| Richtung     | Bedeutung                                        | Menge                                |
| ------------ | ------------------------------------------------ | ------------------------------------ |
| `Erweitern`  | neue Fähigkeit, neuer Anwendungsfall, Anschluss  | mindestens 2, ab 7 Stück ein Drittel |
| `Vertiefen`  | Aufräumen, Vereinfachen, Robustheit, Performance | der Rest                             |
| `Fortsetzen` | der begonnene Faden                              | höchstens 1, ab 8 Stück höchstens 2  |
| `Absichern`  | Tests, Fehlerfälle, Verifikation                 | höchstens 1, ab 8 Stück höchstens 2  |

Die Reihenfolge im Quelltext (`KINDS`) ist die Vorgabe an das Modell, nicht nur
eine Anzeige: `Erweitern` steht zuerst, `Absichern` zuletzt. `Erweitern` darf
über den bisherigen Faden hinausdenken, solange es an die Belege anknüpft.
`Fortsetzen` und `Absichern` sind begrenzt, damit die Liste streut statt den
Faden zu wiederholen. Die beobachteten Lücken werden ausdrücklich als
**Kontext, keine Pflichtliste** eingespielt, damit sie nicht jeden Vorschlag in
Richtung Testarbeit ziehen.

## Wie viele Vorschläge es werden

Die Anzahl steht **nicht** fest. Sie folgt der Belegdichte, nicht der Laune des
Modells: `suggestionBudget()` zählt die unabhängigen Anker (geänderte und
gelesene Dateien, Befehle, Anfragen des Nutzers, Lücken) und leitet daraus eine
Obergrenze ab.

| Anker | Obergrenze |
| ----- | ---------- |
| ≤ 5   | 3          |
| ≤ 10  | 5          |
| ≤ 16  | 7          |
| mehr  | 9          |

Das harte Maximum bleibt `MAX_SUGGESTIONS = 10`, die Untergrenze
`MIN_SUGGESTIONS = 3`. Die Stufen sind bewusst grob — feiner wäre eine
Genauigkeit, die die Belege nicht hergeben.

Die Obergrenze ist ein **Deckel, kein Soll**: der Auftrag sagt ausdrücklich
„Trägt die Session weniger, nimm weniger — auffüllen ist verboten." Zusätzlich
gilt Regel 4 des Auftrags: zwei Vorschläge dürfen sich nicht überschneiden,
Wiederholungen mit anderem Wortlaut zählen nicht als zweiter Vorschlag.

Die Bremse greift zweimal — im Auftrag und im Code: `ask()` schneidet das
Ergebnis zusätzlich auf `suggestionBudget(evidence)` zurück. Ein Modell, das
sich an der Obergrenze vorbeiredet, kommt damit nicht durch. `parseSuggestions`
fasst vorher Duplikate zusammen (ohne Rücksicht auf Schreibweise) und wirft
leere Titel weg.

Erfundene Dateien, Funktionen oder Tests sind untersagt: wer eine Datei nennt,
muss sie aus den Belegen haben. Die Anweisung steht **vor und nach** den
Belegen, sonst setzt das Modell den Verlauf fort, statt zu antworten.

Der Formulartitel zeigt die Anzahl mit an: `Was als Nächstes? (7)`.

## Unterschiede zur Fassung im TUI-Quellbaum

|                             | Quellbaum            | Plugin                         |
| --------------------------- | -------------------- | ------------------------------ |
| Vorschlag landet            | im Composer, prüfbar | wird abgeschickt               |
| "Nutzer tippt gerade"-Guard | ja (`usePromptRef`)  | **nein, nicht ermittelbar**    |
| Steuerung des Auto-Modus    | Experiment-Schalter  | immer an                       |
| Beleganalyse                | einfacher            | Modus, Lücken, vier Richtungen |
| Anzahl der Vorschläge       | fest (3–4)           | aus der Belegdichte, 3–10      |
| Parser und Formular         | identisch            | identisch                      |

Der fehlende Tippen-Guard ist der Preis der externen API. Abgefangen wird das
nur durch "einmal pro Turn" — ein Dialog kann also aufgehen, während getippt
wird.
