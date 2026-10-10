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
Darstellung wie eine Frage des question-Tools, mit nummerierter Liste,
Beschreibungen und dem Hinweis `↑↓ select enter submit esc dismiss`.
Kein Overlay-Fenster.

**Bedienung:** `↑↓` wählt, `enter` schickt die Auswahl ab, `esc` verwirft.
Einfachauswahl ohne `tab`: das Formular hat genau ein Feld, und die Reiterzeile
des Formulars entfällt (siehe unten).

Der gewählte Vorschlag wird **direkt abgeschickt**. Externe Plugins bekommen den
Composer nicht zu sehen (`ui` hat keinen Prompt-Setter), deshalb gibt es keinen
Weg, ihn nur einzufügen.

Das Formular nutzt ein **String-Feld mit `options`** — das ist der native
Einzelauswahl-Typ der Formular-API. Nur damit ist `single()` in der TUI wahr
(`field.type === "string" && field.options !== undefined`) und die Reiterzeile
entfällt; ein `multiselect` (auch mit `maxItems: 1`) schaltet sie ein und das
Formular zeigt dasselbe Feldlabel zweimal — einmal in der Reiterzeile, einmal
als Feldüberschrift.

Warum das Feld keine Texteingabe wird: `formTextual(field)` in
`packages/tui/src/util/form.ts` ist nur für `number`/`integer` oder `string`
**ohne** `options` wahr. `formCustom(field)` bleibt ohne `custom: true` falsch,
es gibt also auch keinen Freitext-Eintrag. `formRows(field)` liefert die
Optionsliste.

Das Feld trägt `title: "Vorschlag"`. Die verbleibende Feldüberschrift ist
`description ?? formLabel(field)` mit
`formLabel(field) = field.title ?? field.key` — der Titel erscheint damit
**genau einmal**.

`id` beim Anlegen ist nur eine optionale Kennung; Titel und Felder stehen auf
oberster Ebene. Anders gelesen scheitert der Aufruf mit
`Expected string | null at ["id"]`.

Zusätzlich öffnet sich die Auswahl automatisch nach `session.idle`, sofern
Belege vorliegen und der Turn nicht schon beantwortet wurde.

## Unterschiede zur Fassung im TUI-Quellbaum

|                             | Quellbaum            | Plugin                      |
| --------------------------- | -------------------- | --------------------------- |
| Vorschlag landet            | im Composer, prüfbar | wird abgeschickt            |
| "Nutzer tippt gerade"-Guard | ja (`usePromptRef`)  | **nein, nicht ermittelbar** |
| Steuerung des Auto-Modus    | Experiment-Schalter  | immer an                    |
| Belege, Parser, Auftrag     | identisch            | identisch                   |

Der fehlende Tippen-Guard ist der Preis der externen API. Abgefangen wird das
nur durch "einmal pro Turn" — ein Dialog kann also aufgehen, während getippt
wird.
