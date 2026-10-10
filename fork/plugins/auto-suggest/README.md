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
Beschreibungen und dem Hinweis `⇆ tab ↑↓ select enter toggle esc dismiss`.
Kein Overlay-Fenster.

**Bedienung:** `tab` wechselt zwischen Liste und `Submit`, `↑↓` wählt, `enter`
hakt ab, dann `tab` auf `Submit` und `enter`. Mit `esc` wird verworfen.

Der gewählte Vorschlag wird **direkt abgeschickt**. Externe Plugins bekommen den
Composer nicht zu sehen (`ui` hat keinen Prompt-Setter), deshalb gibt es keinen
Weg, ihn nur einzufügen.

Das Formular nutzt `multiselect` mit `maxItems: 1`, weil es keinen eigenen
Einzelauswahl-Typ gibt. `id` beim Anlegen ist nur eine optionale Kennung; Titel
und Felder stehen auf oberster Ebene.

Zusätzlich öffnet sich die Auswahl automatisch nach `session.idle`, sofern
Belege vorliegen und der Turn nicht schon beantwortet wurde.

## Unterschiede zur Fassung im TUI-Quellbaum

| | Quellbaum | Plugin |
|---|---|---|
| Vorschlag landet | im Composer, prüfbar | wird abgeschickt |
| "Nutzer tippt gerade"-Guard | ja (`usePromptRef`) | **nein, nicht ermittelbar** |
| Steuerung des Auto-Modus | Experiment-Schalter | immer an |
| Belege, Parser, Auftrag | identisch | identisch |

Der fehlende Tippen-Guard ist der Preis der externen API. Abgefangen wird das
nur durch "einmal pro Turn" — ein Dialog kann also aufgehen, während getippt
wird.
