const ESC = "\x1b["
const useColor = (): boolean => process.stdout.isTTY === true && Bun.env.NO_COLOR === undefined

const wrap = (code: string) => (s: string) => (useColor() ? `${ESC}${code}m${s}${ESC}0m` : s)

export const bold = wrap("1")
export const dim = wrap("2")
export const red = wrap("31")
export const green = wrap("32")
export const yellow = wrap("33")
export const blue = wrap("34")
export const magenta = wrap("35")
export const cyan = wrap("36")

export const RULE = "─"

export const heading = (title: string): string =>
  `\n${bold(cyan(title))}\n${dim(RULE.repeat(Math.min(title.length + 2, 72)))}`

export const ok = (msg: string): string => `${green("✔")} ${msg}`
export const warn = (msg: string): string => `${yellow("▲")} ${msg}`
export const fail = (msg: string): string => `${red("✘")} ${msg}`
export const info = (msg: string): string => `${dim("·")} ${dim(msg)}`

/** Visible width, ignoring ANSI escapes so coloured cells still align. */
export const width = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length

export const padEnd = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - width(s)))

export const padStart = (s: string, n: number): string => " ".repeat(Math.max(0, n - width(s))) + s

export type Row = [string, ...string[]]

export const table = (rows: Row[]): string => {
  if (rows.length === 0) return dim("  (keine Einträge)")
  const columns = Math.max(...rows.map((r) => r.length))
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ""))))
  return rows
    .map((r) => "  " + r.map((c, i) => (i === 0 ? padEnd(c, widths[i] ?? 0) : padStart(c, widths[i] ?? 0))).join("  "))
    .join("\n")
}

export const money = (v: number | null): string => {
  if (v === null) return "—"
  if (v === 0) return "0"
  return v < 0.01 ? v.toFixed(4) : v.toFixed(2)
}

export const count = (v: number): string => {
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B"
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M"
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k"
  return String(v)
}

export const bytes = (v: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let n = v
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export const duration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export const ago = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const d = Date.now() - ms
  if (d < 60_000) return "gerade eben"
  if (d < 86_400_000) return `vor ${duration(d)}`
  if (d < 2_592_000_000) return `vor ${Math.round(d / 86_400_000)}d`
  const s = new Date(ms).toISOString()
  return s.slice(0, 10)
}
