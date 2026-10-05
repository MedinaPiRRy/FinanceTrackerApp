// Turns a bank export (CSV/XLSX rows) into normalized statement rows. Pure and deterministic.
import { parseMoneyToCents } from './money'

export interface StatementRow {
  line: number // 1-based line in the file, for error messages
  date: string // ISO
  description: string // exactly as the bank wrote it
  /** Signed from the account's point of view: money out / card charge is negative, money in / card payment is positive. */
  amountCents: number
}

export interface ParsedStatement {
  format: 'cibc-card' | 'cibc-chequing' | 'headered' | 'unknown'
  rows: StatementRow[]
  warnings: string[]
}

export interface ParseOptions {
  /** Single-amount files only: true if spending is positive in the file (many credit-card exports). */
  flipSign?: boolean
  dateOrder?: 'auto' | 'mdy' | 'dmy'
  /** The user told us which column is which (zero-based). Used when the layout is not recognised automatically. */
  columns?: ColumnMap
}

/** Either one Amount column (signed), or Debit and/or Credit columns. */
export interface ColumnMap { headerRow: boolean; date: number; description: number; amount?: number; debit?: number; credit?: number }

export function validColumnMap(m: unknown): m is ColumnMap {
  if (!m || typeof m !== 'object') return false
  const c = m as Record<string, unknown>
  const idx = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 100
  const opt = (v: unknown) => v === undefined || v === null || idx(v)
  return typeof c.headerRow === 'boolean' && idx(c.date) && idx(c.description) && opt(c.amount) && opt(c.debit) && opt(c.credit) && (c.amount != null || c.debit != null || c.credit != null)
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})/

function validIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Returns an ISO date or null. For ambiguous a/b/yyyy dates the order comes from `order`. */
export function parseDate(input: string, order: 'mdy' | 'dmy' = 'mdy'): string | null {
  const s = input.trim()
  const iso = ISO.exec(s)
  if (iso) return validIso(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  return order === 'mdy' ? validIso(y, a, b) : validIso(y, b, a)
}

/** Decide mdy vs dmy from the whole column: a part above 12 settles it. Defaults to mdy when truly ambiguous. */
export function detectDateOrder(samples: string[]): { order: 'mdy' | 'dmy'; ambiguous: boolean } {
  let first13 = false
  let second13 = false
  for (const s of samples) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/.exec(s.trim())
    if (!m) continue
    if (Number(m[1]) > 12) first13 = true
    if (Number(m[2]) > 12) second13 = true
  }
  if (first13 && !second13) return { order: 'dmy', ambiguous: false }
  if (second13 && !first13) return { order: 'mdy', ambiguous: false }
  return { order: 'mdy', ambiguous: !first13 && !second13 }
}

const looksLikeDate = (s: string) => ISO.test(s.trim()) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s.trim())
const cents = (s: string | undefined) => (s === undefined || s.trim() === '' ? 0 : parseMoneyToCents(s))

/**
 * A short fingerprint of a file's column layout, used to recognise "the same kind of export" next time:
 * the header cells when there is a header row, otherwise the number of columns.
 */
export function layoutOf(rawRows: string[][]): string {
  const rows = rawRows.map((r) => r.map((c) => (c ?? '').toString().trim())).filter((r) => r.some((c) => c !== ''))
  const first = rows[0]
  if (!first) return 'empty'
  if (looksLikeDate(first[0] ?? '')) return `cols:${first.length}`
  const header = rows.slice(0, 5).find((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /desc|payee|merchant|detail|memo|name|narr/i.test(c))) ?? first
  return `h:${header.map((c) => c.toLowerCase().replace(/\s+/g, ' ')).filter(Boolean).join('|')}`
}

/** Rows are arrays of cell strings (already split by the CSV or spreadsheet reader). */
export function parseStatement(rawRows: string[][], opts: ParseOptions = {}): ParsedStatement {
  const rows = rawRows.map((r) => r.map((c) => (c ?? '').toString().trim())).filter((r) => r.some((c) => c !== ''))
  const warnings: string[] = []
  if (rows.length === 0) return { format: 'unknown', rows: [], warnings: ['The file is empty.'] }

  const dateCells = rows.map((r) => r[0] ?? '').filter(looksLikeDate)
  const order = opts.dateOrder && opts.dateOrder !== 'auto' ? { order: opts.dateOrder, ambiguous: false } : detectDateOrder(dateCells)
  if (order.ambiguous && dateCells.some((d) => !ISO.test(d))) warnings.push('Dates like 03/04/2026 could be March 4 or April 3. Assumed month/day/year. Check the preview.')

  const out: StatementRow[] = []
  const skip = (line: number, why: string) => warnings.push(`Line ${line}: skipped (${why}).`)

  // ---- the user mapped the columns themselves ----
  if (opts.columns) {
    const m = opts.columns
    if (!validColumnMap(m)) return { format: 'unknown', rows: [], warnings: ['That column choice is not valid.'] }
    const body = rows.slice(m.headerRow ? 1 : 0)
    const ord = opts.dateOrder && opts.dateOrder !== 'auto' ? { order: opts.dateOrder, ambiguous: false } : detectDateOrder(body.map((r) => r[m.date] ?? ''))
    body.forEach((r, i) => {
      const line = i + (m.headerRow ? 2 : 1)
      const date = parseDate(r[m.date] ?? '', ord.order)
      if (!date) return skip(line, 'unreadable date')
      let amount: number | null
      if (m.amount != null) {
        amount = cents(r[m.amount])
        if (amount !== null && opts.flipSign) amount = -amount
      } else {
        const d = cents(m.debit != null ? r[m.debit] : undefined)
        const c = cents(m.credit != null ? r[m.credit] : undefined)
        amount = d === null || c === null ? null : c - Math.abs(d)
      }
      if (amount === null) return skip(line, 'unreadable amount')
      if (amount === 0) return skip(line, 'no amount')
      out.push({ line, date, description: r[m.description] ?? '', amountCents: amount })
    })
    return { format: 'headered', rows: out, warnings }
  }

  // ---- headerless CIBC exports: date, description, out/charge, in/payment [, card number] ----
  const headerless = looksLikeDate(rows[0]![0] ?? '') && (rows[0]!.length === 4 || rows[0]!.length === 5)
  if (headerless) {
    const format = rows[0]!.length === 5 ? 'cibc-card' : 'cibc-chequing'
    rows.forEach((r, i) => {
      const line = i + 1
      const date = parseDate(r[0] ?? '', order.order)
      const out1 = cents(r[2])
      const in1 = cents(r[3])
      if (!date) return skip(line, 'unreadable date')
      if (out1 === null || in1 === null) return skip(line, 'unreadable amount')
      if (out1 === 0 && in1 === 0) return skip(line, 'no amount')
      out.push({ line, date, description: r[1] ?? '', amountCents: in1 - out1 })
    })
    return { format, rows: out, warnings }
  }

  // ---- files with a header row ----
  const headerIdx = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /desc|payee|merchant|detail|memo|name|narr/i.test(c)))
  if (headerIdx < 0) return { format: 'unknown', rows: [], warnings: ['Could not find a header row with Date and Description columns.'] }
  const header = rows[headerIdx]!.map((h) => h.toLowerCase())
  const col = (re: RegExp, not?: RegExp) => header.findIndex((h) => re.test(h) && !(not && not.test(h)))
  const iDate = col(/date/, /posted|settle/) >= 0 ? col(/date/, /posted|settle/) : col(/date/)
  const iDesc = col(/desc|payee|merchant|detail|narr/) >= 0 ? col(/desc|payee|merchant|detail|narr/) : col(/memo|name/)
  const iAmount = col(/^(amount|amt|transaction amount)$/)
  const iDebit = col(/debit|withdraw|money out|paid out|charge/)
  const iCredit = col(/credit|deposit|money in|paid in|payment/)
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) return { format: 'unknown', rows: [], warnings: ['Could not find Date, Description and Amount (or Debit/Credit) columns.'] }

  const dates = rows.slice(headerIdx + 1).map((r) => r[iDate] ?? '')
  const ord = opts.dateOrder && opts.dateOrder !== 'auto' ? { order: opts.dateOrder, ambiguous: false } : detectDateOrder(dates)
  if (ord.ambiguous && dates.some((d) => d && !ISO.test(d))) warnings.push('Dates like 03/04/2026 could be March 4 or April 3. Assumed month/day/year. Check the preview.')

  rows.slice(headerIdx + 1).forEach((r, i) => {
    const line = headerIdx + i + 2
    const date = parseDate(r[iDate] ?? '', ord.order)
    if (!date) return skip(line, 'unreadable date')
    let amount: number | null
    if (iAmount >= 0) {
      amount = cents(r[iAmount])
      if (amount !== null && opts.flipSign) amount = -amount
    } else {
      const d = cents(iDebit >= 0 ? r[iDebit] : undefined)
      const c = cents(iCredit >= 0 ? r[iCredit] : undefined)
      amount = d === null || c === null ? null : c - Math.abs(d)
    }
    if (amount === null) return skip(line, 'unreadable amount')
    if (amount === 0) return skip(line, 'no amount')
    out.push({ line, date, description: r[iDesc] ?? '', amountCents: amount })
  })
  return { format: 'headered', rows: out, warnings }
}
