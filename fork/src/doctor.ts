import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { open, dataDir, dbPath, tableCount } from "./db.ts"
import { ago, bytes, count, dim, fail, heading, info, ok, table, warn, bold } from "./format.ts"

export type Status = "ok" | "warn" | "fail" | "info"
export type Check = { area: string; status: Status; title: string; detail: string; hint?: string }

const render = (c: Check): string => {
  const mark = { ok, warn, fail }[c.status as "ok" | "warn" | "fail"] ?? info
  const head = `  ${mark(bold(c.title))} ${dim("—")} ${c.detail}`
  return c.hint ? `${head}\n      ${dim("↳ " + c.hint)}` : head
}

const sizeOf = (path: string): number => (existsSync(path) ? statSync(path).size : 0)

const checkBinary = (): Check[] => {
  const binary = Bun.env.OCF_BINARY || join(process.env.HOME ?? "", ".opencode", "bin", "opencode")
  if (!existsSync(binary)) {
    return [
      {
        area: "binary",
        status: "fail",
        title: "opencode binary",
        detail: `nicht gefunden unter ${binary}`,
        hint: "Setze OCF_BINARY oder installiere opencode.",
      },
    ]
  }
  const stat = statSync(binary)
  // Bun setzt mtime auf 1985-10-26 für reproduzierbare Builds
  const reproducible = stat.mtimeMs < Date.UTC(2000, 0, 1)
  return [
    {
      area: "binary",
      status: "ok",
      title: "opencode binary",
      detail:
        `${binary} ${dim(`· ${bytes(stat.size)}`)}` +
        (reproducible ? ` ${dim("· reproduzierbar gebaut (mtime 1985)")}` : ` ${dim(`· mtime ${ago(stat.mtimeMs)}`)}`),
    },
  ]
}

const checkDatabase = (): Check[] => {
  const path = dbPath()
  if (!existsSync(path)) {
    return [
      {
        area: "database",
        status: "fail",
        title: "Session-Datenbank",
        detail: `nicht gefunden: ${path}`,
        hint: "OPENCODE_DB setzen oder opencode einmal starten.",
      },
    ]
  }
  const db = open(path)
  if (!db) return [{ area: "database", status: "fail", title: "Session-Datenbank", detail: "öffnen fehlgeschlagen" }]

  const size = sizeOf(path)
  const wal = sizeOf(path + "-wal")
  const sessions = tableCount(db, "session_v2") + tableCount(db, "session")
  const messages = tableCount(db, "session_message")
  const parts = tableCount(db, "part")
  const mtime = statSync(path).mtimeMs

  const idleMs = Date.now() - mtime
  const stale = idleMs > 30 * 86_400_000
  const out: Check[] = [
    {
      area: "database",
      status: "ok",
      title: "Session-Datenbank",
      detail: `${path} ${dim(`· ${bytes(size)}${wal ? ` (+${bytes(wal)} WAL)` : ""}`)}`,
    },
    {
      area: "database",
      status: "ok",
      title: "Historie",
      detail: `${count(sessions)} Sessions · ${count(messages)} Messages · ${count(parts)} Parts`,
    },
    {
      area: "database",
      status: stale ? "warn" : "ok",
      title: "Letzte Schreiboperation",
      detail: stale ? ago(mtime) : `${ago(mtime)} ${dim("· opencode läuft gerade")}`,
      ...(stale ? { hint: "Die DB wurde über 30 Tage nicht angefasst — evtl. läuft kein Server mehr." } : {}),
    },
  ]

  if (size > 2 * 1024 ** 3) {
    out.push({
      area: "database",
      status: "warn",
      title: "DB-Größe",
      detail: `${bytes(size)} — Sessions dominate den Plattenplatz`,
      hint: "Alte Sessions archivieren/löschen: opencode session list → archive, dann VACUUM.",
    })
  }
  return out
}

const checkModels = (): Check[] => {
  const path = Bun.env.OPENCODE_MODELS_PATH || join(Bun.env.HOME ?? "", ".cache", "opencode", "models.json")
  if (Bun.env.OPENCODE_DISABLE_MODELS_FETCH) {
    return [
      {
        area: "models",
        status: "info",
        title: "Model-Katalog",
        detail: "Fetch deaktiviert (OPENCODE_DISABLE_MODELS_FETCH)",
      },
    ]
  }
  if (!existsSync(path)) {
    return [
      {
        area: "models",
        status: "warn",
        title: "Model-Katalog",
        detail: `kein Cache unter ${path}`,
        hint: "opencode holt die Modelle beim Start; danach landen sie hier.",
      },
    ]
  }
  const age = Date.now() - statSync(path).mtimeMs
  const stale = age > 7 * 86_400_000
  return [
    {
      area: "models",
      status: stale ? "warn" : "ok",
      title: "Model-Katalog",
      detail: `${bytes(statSync(path).size)} · ${ago(statSync(path).mtimeMs)}`,
      ...(stale
        ? {
            hint: "Veraltet. opencode nutzt einen Shim, der den Cache bei jedem Start löscht — OPENCODE_DISABLE_MODELS_FETCH=1 ist der offizielle Schalter dagegen.",
          }
        : {}),
    },
  ]
}

const checkConfig = (): Check[] => {
  const dir = Bun.env.OPENCODE_CONFIG_DIR || join(process.env.HOME ?? "", ".config", "opencode")
  const candidates = ["opencode.json", "opencode.jsonc"]
  const found = candidates.filter((f) => existsSync(join(dir, f)))
  const overrides = [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CLI_CONFIG_CONTENT",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
  ].filter((k) => Bun.env[k])
  return [
    {
      area: "config",
      status: found.length ? "ok" : "warn",
      title: "Konfiguration",
      detail: found.length ? `${dir}/${found[0]}` : `keine opencode.json in ${dir}`,
      ...(overrides.length ? { hint: `Aktiv via env: ${overrides.join(", ")}` } : {}),
    },
  ]
}

const checkLogs = (): Check[] => {
  const dir = join(dataDir(), "log")
  if (!existsSync(dir)) return [{ area: "logs", status: "info", title: "Logs", detail: "kein Log-Verzeichnis" }]

  const fresh = Bun.spawnSync(["find", dir, "-maxdepth", "1", "-name", "*.log", "-mmin", "-1440"])
  const lines = new TextDecoder().decode(fresh.stdout).trim()
  const n = lines ? lines.split("\n").length : 0

  let total = 0
  for (const entry of readdirSync(dir)) total += sizeOf(join(dir, entry))

  const errors = Bun.spawnSync(["grep", "-rlc", "ERROR", dir]).stdout.length > 0

  return [
    {
      area: "logs",
      status: "ok",
      title: "Logs",
      detail: `${n} Log-Datei(en) in den letzten 24h · ${bytes(total)} gesamt`,
      ...(errors
        ? {
            hint: `ERROR-Marker gefunden. Details: grep -rn ERROR ${dir} | tail -40`,
          }
        : {}),
    },
  ]
}

export const doctor = async (): Promise<number> => {
  const checks: Check[] = [...checkBinary(), ...checkDatabase(), ...checkModels(), ...checkConfig(), ...checkLogs()]

  console.log(heading("ocf doctor — opencode Umgebungsdiagnose"))

  const areas = [...new Set(checks.map((c) => c.area))]
  for (const area of areas) {
    console.log(`\n${bold(area.toUpperCase())}`)
    checks.filter((c) => c.area === area).forEach((c) => console.log(render(c)))
  }

  const fails = checks.filter((c) => c.status === "fail").length
  const warns = checks.filter((c) => c.status === "warn").length

  console.log(
    `\n${table([
      ["Checks", String(checks.length)],
      ["Fehler", String(fails)],
      ["Warnungen", String(warns)],
    ])}\n`,
  )
  return fails > 0 ? 1 : 0
}
