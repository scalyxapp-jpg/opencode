#!/usr/bin/env bun
import { doctor } from "./doctor.ts"
import { ledger } from "./ledger.ts"
import { exportSession, overview } from "./sessions.ts"
import { recall } from "./recall.ts"

const VERSION = "0.1.0"

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

const usage = (): string => `
${C.bold("ocf")} ${C.dim(`v${VERSION}`)} — Werkzeuge rund um deine opencode-Installation

${C.bold("NUTZUNG")}
  bun run src/cli.ts <kommando> [args] [flags]

${C.bold("KOMMANDOS")}
  ${C.cyan("doctor")}                     Umgebungsdiagnose: Binary, DB, Model-Cache, Config, Logs
  ${C.cyan("recall")} <begriff>           Volltextsuche durch die gesamte Session-Historie
  ${C.cyan("ledger")}                     Kosten- und Token-Analyse aus der Session-DB
  ${C.cyan("sessions")} [filter]          Session-Übersicht
  ${C.cyan("export")} <session-id>        Session als Markdown exportieren
  ${C.cyan("analyze")}                    Binary-Analyse neu ausführen
  ${C.cyan("upstream")} [args...]         Originales opencode starten (unangetastet durchgereicht)

${C.bold("FLAGS")}
  --limit <n>      Maximale Treffer (recall/sessions)
  --group <g>      day | model | project | agent   ${C.dim("(ledger, default: day)")}
  --days <n>       Zeitraum in Tagen                ${C.dim("(ledger, default: 30)")}
  --project <s>    Auf Verzeichnis eingrenzen       ${C.dim("(recall)")}
  --since <ms>     Zeitstempel-Untergrenze          ${C.dim("(recall)")}
  --parts          Auch in part-Tabelle suchen      ${C.dim("(recall)")}
  --deep           Auch in Reasoning + Tool-Output  ${C.dim("(recall)")}
  -o <pfad>        Ausgabedatei                     ${C.dim("(export)")}

${C.bold("BEISPIELE")}
  bun run src/cli.ts recall "tailwind konfig"
  bun run src/cli.ts ledger --group model --days 90
  bun run src/cli.ts doctor
`

type Flags = Record<string, string | boolean>

/** Akzeptiert `--key value`, `--key=value` und Kurzformen wie `-o file`. */
const parse = (argv: string[]): { positional: string[]; flags: Flags } => {
  const positional: string[] = []
  const flags: Flags = {}
  const known = new Set(["limit", "group", "days", "project", "since", "o", "out", "binary"])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    if (eq > 0) {
      flags[arg.slice(2).replace(/^-+/, "")] = arg.slice(eq + 1)
      continue
    }
    const key = arg.replace(/^-+/, "")
    const next = argv[i + 1]
    if (known.has(key) && next && !next.startsWith("-")) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

const asInt = (v: string | boolean | undefined, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage())
    return 0
  }
  if (command === "version" || command === "--version") {
    console.log(VERSION)
    return 0
  }

  const { positional, flags } = parse(rest)

  switch (command) {
    case "doctor":
      return doctor()

    case "recall": {
      const query = positional.join(" ")
      return recall(query, {
        limit: asInt(flags.limit, 20),
        since: asInt(flags.since, 0),
        project: typeof flags.project === "string" ? flags.project : undefined,
        parts: flags.parts === true,
        deep: flags.deep === true,
      })
    }

    case "ledger": {
      const group = flags.group
      if (group && !["day", "model", "project", "agent"].includes(String(group))) {
        console.error(`Unbekannte Gruppe: ${group} (erlaubt: day, model, project, agent)`)
        return 1
      }
      return ledger({
        group: (group as "day") ?? "day",
        days: asInt(flags.days, 30),
        limit: asInt(flags.limit, 0) || undefined,
      })
    }

    case "sessions":
      return overview({
        limit: asInt(flags.limit, 20),
        filter: positional[0],
      })

    case "export": {
      const id = positional[0]
      if (!id) {
        console.error("Session-ID fehlt: ocf export <session-id>")
        return 1
      }
      const out = flags.o ?? flags.out
      return exportSession(id, typeof out === "string" ? out : undefined)
    }

    case "analyze": {
      const bin = typeof flags.binary === "string" ? flags.binary : "fork/baseline/opencode.bin"
      const proc = Bun.spawn(["python3", "fork/tools/analyze-binary.py", bin], {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
      })
      return await proc.exited
    }

    case "upstream": {
      const binary = Bun.env.OCF_BINARY || `${process.env.HOME}/.opencode/bin/opencode`
      const proc = Bun.spawn([binary, ...rest], { stdout: "inherit", stderr: "inherit", stdin: "inherit" })
      return await proc.exited
    }

    default:
      console.error(`${C.bold("Unbekanntes Kommando:")} ${command}\n`)
      console.log(usage())
      return 1
  }
}

process.exit(await main())
