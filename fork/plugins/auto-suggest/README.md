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
```

Die Vorschläge erscheinen als **Formular inline im Verlauf** — dieselbe
Darstellung wie eine Frage des question-Tools, mit nummerierter Liste, Kästchen
zum Anhaken, Beschreibungen und dem Hinweis
`⇆ tab ↑↓ select enter toggle esc dismiss`.
Kein Overlay-Fenster.

**Bedienung:** `↑↓` wählt, `enter`/`space` hakt an, `tab` und `enter` übernehmen
die angehakten Vorschläge, `esc` verwirft.

Werden mehrere Vorschläge angehakt, gehen sie als **eine** Anfrage mit
Reihenfolge raus (`Übernimm diese Vorschläge der Reihe nach: …`); daraus wird ein
Turn statt mehrerer, und der Agent teilt die Arbeit selbst auf.

Der gewählte Vorschlag wird **direkt abgeschickt**. Externe Plugins bekommen den
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

Warum das Feld keine Texteingabe wird: `formTextual(field)` in
`packages/tui/src/util/form.ts` ist nur für `number`/`integer` oder `string`
**ohne** `options` wahr. `formCustom(field)` bleibt ohne `custom: true` falsch,
es gibt also auch keinen Freitext-Eintrag. `formRows(field)` liefert die
Optionsliste.

`id` beim Anlegen ist nur eine optionale Kennung; Titel und Felder stehen auf
oberster Ebene. Anders gelesen scheitert der Aufruf mit
`Expected string | null at ["id"]`.

Zusätzlich öffnet sich die Auswahl von selbst, sobald der Agent einen Turn
abgeschlossen hat. Auslöser ist das Ereignis **`session.execution.succeeded`**:
es wird vom Laufzeitkoordinator beim Commit jedes abgeschlossenen Durchlaufs
veröffentlicht. `session.idle` und `session.status` sind im Schema als
deprecated markiert und werden vom Server nicht mehr publiziert — solange das
Plugin darauf hörte, ging die Auswahl nie von selbst auf.

Damit kein Turn verpasst wird, wartet der Handler einen Moment und fasst dann
nach, bis die Nachrichtenliste des Clients den neuen Assistenten-Turn zeigt
(das Ereignis kommt mit dem Commit, die Liste kann kurz hinterherhinken).

Geöffnet wird nur, wenn mindestens zwei Auswertungs-Turns vorliegen und in der
Session wirklich etwas passiert ist (Datei geändert, Befehl ausgeführt oder
Fehlschlag), und höchstens einmal pro Turn. Sonst käme der Vorschlag aus dem
Nichts.

### Genau eine Runde pro Anfrage — auch bei Hot-Reload und mehreren Fenstern

Das Ereignis allein genügt dafür nicht. Zwei Dinge sorgen sonst dafür, dass
mehrere Formulare mit jeweils **eigenen** Vorschlägen erscheinen:

- **Der Ereigniskanal räumt nicht selbst auf.** `data.on` hängt am globalen
  Emitter des Hosts (`createGlobalEmitter`) und liefert einen Abmelder. Wird der
  nicht zurückgegeben, bleibt nach **jedem Hot-Reload** der alte Zuhörer aktiv —
  und jede weitere Fassung erzeugt dann ihre eigene Runde. `setup()` gibt
  deshalb einen Aufräumer zurück, der die Zuhörer abmeldet; der Host ruft ihn
  beim Ablösen auf.
- **Ein `pending`-Flag gilt nur innerhalb einer Instanz.** Mehrere Fenster hören
  dasselbe Ereignis. Deshalb wird die Runde in der **Plugin-Ablage** beansprucht
  (`storage.store("offered")`): das Schreiben läuft unter Dateisperre, die
  Prüfung passiert darin, und nur wer sie gewinnt, generiert und legt an. Der
  Schlüssel ist die letzte **Anfrage des Nutzers**, nicht die letzte
  Assistenten-Nachricht — eine Anfrage kann mehrere Schritte haben, ergibt aber
  genau eine Runde.

Zusammen mit `answeredTurn` und `keepSoleForm` heißt das: **eine Generierung,
ein Formular, eine Absendung pro Anfrage.**

> Nach einer Plugin-Änderung sollte opencode einmal neu gestartet werden.
> Fassungen ohne Aufräumer haben ihre Zuhörer nie abgemeldet; die alten bleiben
> bis zum Prozessende aktiv, weil ihre Runden nicht an der Ablage hängen.

### Es gibt genau ein Formular — nicht mehrere

Ein unbeantwortetes Formular bleibt serverseitig offen, und die Oberfläche zeigt
immer das **älteste**. Ohne Aufräumen sammelt sich deshalb eines nach dem
anderen an: `esc` schließt dann zwar eines, aber an seiner Stelle erscheint
sofort das nächste gleich aussehende — es wirkt, als ließe sich die Auswahl
überhaupt nicht schließen, oder als ginge sie immer wieder von selbst auf.

Dagegen vier Vorkehrungen:

- **Erst nachsehen, dann anlegen.** Vor jedem Anlegen wird geprüft, ob schon ein
  Vorschlagsformular offen ist; dann wird **dieses benutzt** statt ein zweites
  daneben zu legen. Es wird dabei nicht geschlossen und neu erzeugt — das würde
  bei mehreren Fenstern zum ständigen Ersetzen führen.
- **Doppelgänger werden weggeräumt** (`keepSoleForm`, erkannt am Feldschlüssel
  `next`). Es bleibt das älteste stehen, weil die Oberfläche genau das zeigt.
  Fremde Formulare — etwa Berechtigungsabfragen — bleiben unangetastet.
- **Nur der Ersteller sendet ab.** Jedes Formular trägt in den Metadaten eine
  Besitzerkennung (`autoSuggestOwner`). Mehrere Fenster hören dasselbe Ereignis
  und warten auf dasselbe Formular; ohne diese Kennung ginge dieselbe Auswahl
  mehrfach raus. Wer nicht der Ersteller ist, wartet trotzdem — damit ein liegen
  gebliebenes Formular nach der Wartezeit aufgeräumt wird.
- **Zeitablauf räumt selbst weg.** Läuft die Wartezeit von zehn Minuten ab, ohne
  dass jemand antwortet, wird das Formular abgebrochen (`waitForAnswer`) und
  bleibt nicht liegen.

Zusammen mit `answeredTurn` (ein Durchlauf wird nur einmal ausgewertet) und dem
`pending`-Riegel (während ein Formular offen ist, wird keines angelegt) ergibt
das: **genau ein Formular pro abgeschlossenem Turn**, und nach `esc` kommt keines
von selbst zurück.

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
