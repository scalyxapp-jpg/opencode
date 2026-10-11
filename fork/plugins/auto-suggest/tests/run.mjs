// Führt alle Prüfsuiten nacheinander aus und endet mit einem von null
// verschiedenen Rückgabewert, sobald eine Prüfung fehlschlägt.
//
// Die Suiten sind rein lokal: sie lesen tui.js, kopieren den Quelltext zum
// Importieren ins Systemverzeichnis und arbeiten sonst mit Fakes. Kein Netz,
// kein Zugriff auf einen laufenden Server — aufrufbar über
//
//   bun run test        (im Ordner fork/plugins/auto-suggest)
//
// Jede Suite meldet am Ende "N bestanden, M fehlgeschlagen" und beendet sich
// selbst mit Fehler, sobald M größer als null ist.
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(here)
  .filter((name) => /^\d+-.+\.mjs$/.test(name))
  .sort()

const rows = []
for (const name of suites) {
  const result = spawnSync(process.execPath, [join(here, name)], { encoding: "utf8", timeout: 600_000 })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  const summary = /(\d+) bestanden, (\d+) fehlgeschlagen/.exec(output)
  const ok = result.status === 0 && summary !== null
  rows.push({
    name,
    ok,
    good: summary ? Number(summary[1]) : 0,
    bad: summary ? Number(summary[2]) : 1,
    failures: output.split("\n").filter((line) => line.includes("FAIL")),
    tail: output.trim().split("\n").slice(-3).join(" | "),
  })
}

console.log("")
console.log("Prüfsuiten des Plugins auto-suggest")
console.log("")
const width = Math.max(...suites.map((name) => name.length), 10)
for (const row of rows) {
  const line = `${row.ok ? "ok  " : "FEHL"} ${row.name.padEnd(width)}  ${row.good} bestanden, ${row.bad} fehlgeschlagen`
  console.log(line)
  if (!row.ok) {
    for (const failure of row.failures.slice(0, 20)) console.log(`       ${failure.trim()}`)
    if (!row.failures.length) console.log(`       ${row.tail}`)
  }
}

const good = rows.reduce((sum, row) => sum + row.good, 0)
const bad = rows.reduce((sum, row) => sum + row.bad, 0)
const broken = rows.filter((row) => !row.ok).length
console.log("")
console.log(`Summe: ${good} bestanden, ${bad} fehlgeschlagen in ${rows.length} Suiten`)
if (!rows.length) console.log("Keine Suite gefunden — erwartet werden Dateien wie 1-evidence.mjs")

// Fehler zählen doppelt Gewicht: eine Suite, die gar nicht erst startet, muss
// den Lauf genauso scheitern lassen wie eine falsche Erwartung.
process.exit(bad > 0 || broken > 0 || !rows.length ? 1 : 0)
