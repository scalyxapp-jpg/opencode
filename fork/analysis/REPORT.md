# Analyse: opencode v2.0.23 Standalone-Binary

Erzeugt von `fork/tools/analyze-binary.py`. Alle Werte sind aus der Datei selbst
ausgelesen, nicht aus der Doku.

## Identität

```
Datei      fork/baseline/opencode.bin  (Kopie von ~/.opencode/bin/opencode)
SHA-256    a233de331f4438336e604d8e006fdab18e5911c4ece16de8e502eb61394c3586
Größe      203.777.504 Bytes (194,3 MiB)
Format     ELF 64-bit LSB executable, x86-64, dynamically linked
Build-ID   5afca2666bfab8605a934f1b6231dacae0518a5f
mtime      1985-10-26  ← reproduzierbarer Build (Bun-Signatur)
Stripped    nein, aber nur 2.136 FUNC/OBJECT-Symbole → Bun-Runtime ist reduziert
```

Abhängigkeiten: `libc.so.6`, `ld-linux-x86-64.so.2`, `libpthread.so.0`, `libdl.so.2`,
`libm.so.6`. Keine libstdc++/libgcc → der native Anteil ist reines C ohne Exception-
Runtime.

## Sektionsauflistung

38 Sektionen. Die relevanten:

| Sektion         | Offset      | Größe        | Anteil     | Inhalt                                  |
| --------------- | ----------- | ------------ | ---------- | --------------------------------------- |
| `.rodata`       | `0x013000`  | 19,9 MB      | 9,8 %      | Strings, Konstanten                     |
| `.bun`          | `0x4d7f000` | **122,5 MB** | **60,1 %** | eingebettetes Modul-Graph               |
| `.bun_builtins` | `0x12f3e00` | 2,6 MB       | 1,3 %      | Bun-Builtin-Module                      |
| `.text`         | `0x1572800` | 56,8 MB      | 27,8 %     | nativer Code (Bun + JSC + opencode-pty) |
| `.data`         | —           | 59 KB        | < 1 %      |                                         |
| `.bss`          | —           | 1,8 MB       | < 1 %      |                                         |

Der Rest der Datei (`.symtab`, `.strtab`, `.shstrtab`, `.comment`,
`.note.stapsdt`) belegt 430 KB am Dateiende. Die Section-Header-Tabelle sitzt bei
`0xc255c60`, also unmittelbar vor dem String-Bereich.

## Runtime-Startup

Am Ende der `.bun`-Sektion steht die Kommandozeile, mit der das Binary seinen
eigenen App-Code startet:

```
--smol --user-agent=opencode/latest/2.0.23/cli --use-system-ca --no-warnings --
```

`--smol` ist der entscheidende Befund: v2 startet **effect-smol** als Runtime-Host,
nicht Bun direkt. Bun ist nur der Träger und der JavaScriptCore.

`--use-system-ca` nutzt die System-CA-Szene statt Buns eingebauter Roots — relevant,
weil der Nutzer hinter einem Tor-/Proxy-Setup arbeitet.

Direkt danach folgt die Modul-Graph-Tabelle (Pfad-Längen und Offsets) und abschließend
die Markierung `\n---- Bun! ----\n`.

## Eingebettetes Dateisystem `/$bunfs/root/`

436 Dateien, vollständig inventarisiert in `bunfs-manifest.json`:

| Kategorie                     | Anzahl | Beispiele                                                                                                                                                   |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundler-Chunks `*.js`         | 397    | `chunk-5f85s6f0.js` …                                                                                                                                       |
| Prompt-Presets `*.txt`/`*.md` | 13     | `system-*.txt`, `anthropic-*.txt`, `kimi-*.txt`, `gpt-*.txt`, `trinity-*.txt`, `meta-*.txt`, `review-*.txt`, `report-*.md`, `snapshot-*.txt`, `patch-*.txt` |
| WASM                          | 9      | tree-sitter: typescript, javascript, markdown, markdown_inline, bash, powershell, zig · `photon_rs_bg.wasm`                                                 |
| Syntax-Highlighting `*.scm`   | 6      | `highlights-*.scm`, `injections-*.scm`                                                                                                                      |
| Native Libraries `*.so`       | 3      | `libopentui-*.so`, `libfff_c-*.so`, `librust_pty-*.so`                                                                                                      |
| Native Addon `*.node`         | 1      | `watcher-*.node`                                                                                                                                            |
| Audio `*.mp3`                 | 5      | Terminal-Soundeffekte                                                                                                                                       |
| Sonstige                      | 2      | `parser.worker-*.js`, `opencode-pty-*`                                                                                                                      |

Bemerkenswert: `libopentui` ist die native Terminal-Bibliothek. Das TUI ist also
TypeScript auf einer nativen Rust/C-Bibliothek — nicht Go, kein ncurses. `libfff_c`
ist der Syntax-Highlighter-Accelerator, `librust_pty` der PTY-Backend-Ersatz.

## CLI-Oberfläche

Vollständig in `cli-help.txt`. Subkommandos: `upgrade`, `uninstall`, `acp`, `api`,
`debug`, `auth`, `mcp`, `plugin`, `models`, `stats`, `mini`, `run`, `session`,
`service`, `reload`, `pair`, `serve`.

Globale Flags: `--standalone`, `--server <url>`, `--auto`, `--continue`, `--session`,
`--prompt`, `--wizard`, `--completions`, `--log-level`, `--print-logs`.

## Umgebungsvariablen

42 `OPENCODE_*`-Variablen extrahiert (`env-vars.txt`). Die für Betrieb und
Fehlersuche wichtigsten:

| Variable                                                              | Wirkung                           |
| --------------------------------------------------------------------- | --------------------------------- |
| `OPENCODE_DB`                                                         | Pfad zur Session-DB               |
| `OPENCODE_DISABLE_MODELS_FETCH`                                       | Model-Katalog nicht aktualisieren |
| `OPENCODE_MODELS_PATH` / `OPENCODE_MODELS_URL`                        | Katalogquelle überschreiben       |
| `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` | Config-Overlay                    |
| `OPENCODE_LOG_LEVEL` / `OPENCODE_PRINT_LOGS`                          | Diagnose                          |
| `OPENCODE_SESSION_ID`                                                 | Session fest vorgeben             |
| `OPENCODE_DISABLE_AUTOUPDATE`                                         | Selbstupdate unterbinden          |
| `OPENCODE_WORKTREE_BASE` / `OPENCODE_WORKTREE_PATH`                   | Worktree-Handling                 |
| `OPENCODE_DIRECT_TRACE` / `OPENCODE_SHOW_TTFD`                        | Trace-Ausgabe                     |

`OPENCODE_DISABLE_MODELS_FETCH` ist der offizielle Schalter gegen das Verhalten, das
der lokale Shim in `~/.local/bin/opencode` mit `rm -f ~/.cache/opencode/models.json`
emuliert. Siehe `ocf doctor`.

## Belastbarkeit der Analyse

Grenzen, die man kennen sollte:

- Die **Inhalte** der 397 Chunks wurden nicht dekomprimiert. Das Bun-Format im
  `.bun`-Abschnitt ist undokumentiert; eine Teil-Extraktion lohnt sich nicht, weil der
  identische Quellcode im Repo unter `packages/` liegt.
- String-Extraktion ist verrauscht: 272.304 Kandidaten, davon viele aus dem
  JavaScriptCore und aus tree-sitter-Grammatiken. Für gezielte Fragen
  (`strings -n 20 | grep …`) ist sie brauchbar, für Vollständigkeit nicht.
- Aussagen zum Datenbankschema stammen aus der **Live-DB** (27 Tabellen), nicht aus
  dem Binary.

## Was daraus folgt

Der Binary ist kein Blackbox-Gegenstand. Er ist ein Bun-Standalone-Build von genau dem
Quellcode, der im Repository liegt. Die sinnvolle Arbeit liegt deshalb nicht im
Patchen des Binaries, sondern in der Ebene darüber — was `ocf` tut: read-only
Datenzugriff auf die Session-Historie, die opencode selbst anbietet, aber nie
auswertet.
