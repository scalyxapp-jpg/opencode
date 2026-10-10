import { open, allSessions, sessionMessages } from "./db.ts"
import { parse, visibleText, toolSummary } from "./extract.ts"
import { ago, bold, count, cyan, dim, heading, money, table, type Row } from "./format.ts"

export const overview = async (opts: { limit?: number; filter?: string } = {}): Promise<number> => {
  const db = open()
  if (!db) {
    console.error("Keine opencode-Datenbank gefunden.")
    return 1
  }
  const limit = opts.limit ?? 20
  const filter = opts.filter?.toLowerCase()
  const all = allSessions(db)
  const sessions = all
    .filter((s) => !filter || (s.title ?? "").toLowerCase().includes(filter) || s.id.includes(filter ?? ""))
    .slice(0, limit)

  console.log(heading(`ocf sessions — ${sessions.length} von ${all.length}`))
  if (sessions.length === 0) {
    console.log(`\n  ${dim("Keine Sessions.")}\n`)
    return 0
  }

  console.log()
  console.log(
    table([
      [bold("ID"), bold("TITEL"), bold("LETZTE"), bold("DAUER"), bold("KOSTEN"), bold("TOKENS")],
      ...sessions.map(
        (s): Row => [
          cyan(s.id.slice(0, 12)),
          (s.title ?? "(ohne Titel)").slice(0, 46),
          ago(s.time_updated),
          s.time_updated > s.time_created ? Math.round((s.time_updated - s.time_created) / 60000) + "m" : "—",
          money(s.cost),
          count((s.tokens_input ?? 0) + (s.tokens_output ?? 0)),
        ],
      ),
    ]),
  )
  console.log(dim(`\n  exportieren:  ocf export <session-id>\n  weitersetzen: opencode --session <session-id>\n`))
  return 0
}

const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ")

export const exportSession = async (sessionId: string, outPath?: string): Promise<number> => {
  const db = open()
  if (!db) return 1
  const session = allSessions(db).find((s) => s.id === sessionId || s.id.startsWith(sessionId))
  if (!session) {
    console.error(`Session nicht gefunden: ${sessionId}`)
    return 1
  }

  const messages = sessionMessages(db, session.id)
  const lines: string[] = [
    `# ${session.title ?? "Untitled session"}`,
    "",
    `- **Session:** \`${session.id}\``,
    `- **Verzeichnis:** \`${session.directory ?? "?"}\``,
    `- **Erstellt:** ${new Date(session.time_created).toISOString()}`,
    `- **Agent:** ${session.agent ?? "?"}`,
    `- **Kosten:** ${money(session.cost)} · **Tokens:** ${count((session.tokens_input ?? 0) + (session.tokens_output ?? 0))}`,
    `- **Nachrichten:** ${messages.length}`,
    "",
    "---",
    "",
  ]

  for (const m of messages) {
    const kind = String(m.type ?? "text")
    const data = String(m.data ?? "")
    const payload = parse(data)
    const body = visibleText(data).trim()

    lines.push(
      `## ${kind === "user" ? "👤 User" : kind === "assistant" ? "🤖 Assistant" : kind} · ${stamp(Number(m.time_created))}`,
    )
    lines.push("")
    if (body) lines.push(body, "")

    for (const block of payload?.content ?? []) {
      const t = toolSummary(block)
      if (t) lines.push(`- 🔧 ${t}`)
    }
    if ((payload?.content ?? []).some((b) => b.type === "tool")) lines.push("")

    const err = payload?.error?.data?.message
    if (err) lines.push(`> **Fehler:** ${err}`, "")
  }

  const markdown = lines.join("\n")
  if (outPath) {
    await Bun.write(outPath, markdown)
    console.log(
      `${bold("geschrieben")} ${outPath} ${dim(`(${count(markdown.length)} Zeichen · ${messages.length} Nachrichten)`)}\n`,
    )
  } else {
    if (markdown.length > 40_000 && !Bun.env.OCF_FORCE) {
      console.error(
        `Export ist ${count(markdown.length)} Zeichen groß — mit -o <datei> schreiben oder OCF_FORCE=1 setzen.\n`,
      )
      return 1
    }
    console.log(markdown)
  }
  return 0
}
