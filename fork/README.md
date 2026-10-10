# ocf — opencode fork

Werkzeuge, die auf deiner **installierten** opencode-Instanz aufsetzen, ohne sie zu
verändern. Das Original-Binary wird nie angefasst; `ocf` liest nur.

```
fork/
├── bin/ocf              Launcher
├── src/                 TypeScript (Bun)
│   ├── cli.ts           Argument-Parser + Dispatch
│   ├── db.ts            read-only Zugriff auf opencodes SQLite-DB
│   ├── extract.ts       Message-Extraktion aus den JSON-data-Blobs
│   ├── doctor.ts        Umgebungsdiagnose
│   ├── recall.ts        Volltextsuche durch die Session-Historie
│   ├── ledger.ts        Kosten- und Token-Analyse
│   ├── sessions.ts      Session-Übersicht + Markdown-Export
│   └── format.ts        Terminal-Rendering
├── tools/
│   └── analyze-binary.py   Statische Analyse des Bun-Standalone-Binaries
├── analysis/            Erzeugte Analyse-Artefakte
└── baseline/
    └── opencode.bin     Kopie des Originals (Referenz, SHA verifiziert)
```

## Benutzung

```bash
./fork/bin/ocf doctor
./fork/bin/ocf recall "tailwind konfig" --deep
./fork/bin/ocf ledger --group model --days 90
./fork/bin/ocf export ses_faf59d67 -o session.md
```

Optional auf dem PATH: `ln -s "$PWD/fork/bin/ocf" ~/.local/bin/ocf`

## Kommandos

| Kommando            | Zweck                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `doctor`            | Diagnose: Binary, DB, Model-Cache, Config, Logs — mit Handlungstipps |
| `recall <begriff>`  | Volltextsuche durch die gesamte Session-Historie                     |
| `ledger`            | Kosten/Token nach Tag, Modell, Projekt oder Agent                    |
| `sessions [filter]` | Session-Übersicht mit Kosten, Dauer, Token                           |
| `export <id>`       | Session als Markdown (User/Assistant/Tool-Aufrufe)                   |
| `analyze`           | Binary-Analyse neu ausführen                                         |
| `upstream [args]`   | Originales opencode starten, Argumente durchgereicht                 |

### recall

Zwei Tiefen: Standard ist **sichtbarer Text** (Prompts + Antworten). Findet sich dort
nichts, eskaliert der Befehl automatisch auf **Tiefensuche** (Reasoning + Tool-Ein- und
-Ausgaben) und sagt das an. `--deep` erzwingt es, `--parts` zieht zusätzlich die
`part`-Tabelle heran.

Ranking: Trefferhäufigkeit × 2, plus Bonus für User- (3) und Assistant-Messages (2).

### ledger

Liest `session_v2` und ergänzt `session`-Zeilen ohne v2-Gegenstück, ist also über beide
Schema-Generationen hinweg vollständig. Cache-Hit-Rate = `cache_read / (cache_read + input)`.

## TUI-Features (Branches `tui-cost-meter`, `sidebar-pulse`)

Diese Änderungen liegen **im opencode-Quellcode** unter `packages/tui`, nicht in `ocf`.

### `/cost` — Session-Rechnung

Kosten und Token je Modell, Summenzeile, Cache-Hit-Rate, Cache-Writes und ein
Kontextbalken. Grundlage sind die `tokens`/`cost`-Felder, die opencode pro
Assistant-Message speichert und bisher nirgends anzeigt.

### Kontextdruck in der Prompt-Footerzeile

`contextPressure()` liefert Tokenzahl, Prozent, Restbudget und eine Druckstufe.
Ab 70 % wechselt die Zeile auf `text.feedback.warning`, ab 90 % auf
`text.feedback.error`, und das Format wechselt von `168.4K (16%)` auf
`70% · 314.6K free`.

Unter Druck bleibt die Zeile bewusst kurz: `promptFooterLayout` gibt bei Breite 80
nur 44 Zeichen für usage + shortcuts frei.

### Context-Puls in der Sidebar

Sparkline des Kontextverlaufs über die Turns, älteste links, jeder Balken nach
eigener Druckstufe eingefärbt. Skaliert gegen den Spitzenwert der Session, zeigt
auf 42 Spalten die letzten 34 Turns. Weil die Werte nicht monoton wachsen, macht
eine Kompaktierung den Verlauf lesbar.

### Erweitertes `/status`

Statt nur MCP-Servern auch Provider- und Modell-Zustand: nutzbare Provider,
leerer Modellkatalog und eine Handlungsanweisung. Deckt den klassischen
Fehlerfall ab, dass kein Provider authentifiziert ist.

### Storybook

`session-cost` und `context-pulse` unter
`packages/tui/src/feature-plugins/system/storybook`. Start:
`OPENCODE_STORY=context-pulse bun run dev:live` aus dem Repo-Wurzelverzeichnis.

## Sicherheitsgarantien

- Die DB wird mit `readonly: true` **und** `PRAGMA query_only = 1` geöffnet. Ein Absturz
  mitten im Schreiben könnte sonst 3,8 GB Session-Historie zerstören.
- `baseline/opencode.bin` ist eine Kopie. Das Original unter `~/.opencode/bin/opencode`
  wird nie geschrieben.
- `analyze-binary.py` liest nur, es schreibt ausschließlich nach `fork/analysis/`.

## Analyse-Ergebnis

Vollständiger Bericht: [`analysis/REPORT.md`](analysis/REPORT.md).

Kurzfassung des v2.0.23-Binaries:

| Eigenschaft          | Wert                                           |
| -------------------- | ---------------------------------------------- |
| Größe                | 203.777.504 Bytes                              |
| `.bun`-Sektion       | 122.464.755 Bytes (60 %)                       |
| Eingebettete Dateien | 436 (`/$bunfs/root/`)                          |
| davon Bundler-Chunks | 397 `.js`                                      |
| Native Libraries     | `libopentui`, `libfff_c`, `librust_pty`        |
| WASM                 | 9 (tree-sitter-Grammatiken, photon_rs_bg)      |
| Prompt-Presets       | 13 (`.txt`/`.md`)                              |
| Symbole im ELF       | 2.136 FUNC/OBJECT                              |
| Runtime              | `smol --user-agent=opencode/latest/2.0.23/cli` |

Das Binary ist ein Bun-Standalone-Executable, das **effect-smol** als Runtime-Host
startet und den gesamten App-Code als 397 Bundler-Chunks im `.bun`-Abschnitt mitführt.
Der Quellcode dazu liegt im Repo unter `packages/` — das Binary ist also kein
Blackbox-Problem, sondern eine Frage der Versions-Differenz.
