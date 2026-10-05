// Finds regular payments (subscriptions, bills, rent, pay) in a person's own transactions, and notices when a payment
// that used to appear has stopped. Pure and deterministic: the same transactions always give the same answer.
import { addDays, daysBetween } from './dates'
import { keyMatches } from './categorize'
import { displayName } from './normalize'

export type DetectedFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
export type Direction = 'income' | 'expense'

export interface DetectTxn { key: string; date: string; amountCents: number; direction: Direction; accountId: number }

export interface Detected {
  key: string
  direction: Direction
  name: string
  frequency: DetectedFrequency
  /** The latest amount, positive. */
  amountCents: number
  accountId: number
  occurrences: number
  firstDate: string
  lastDate: string
  nextExpected: string
  confidence: 'high' | 'medium'
}

const PERIOD: Record<DetectedFrequency | 'semimonthly' | 'yearly', number> = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30, quarterly: 91, yearly: 365 }
/** How far an interval may stray from the ideal period and still count as "on schedule" (bills slip over weekends and month ends). */
const TOLERANCE: Record<DetectedFrequency, number> = { weekly: 2, biweekly: 2, monthly: 4, quarterly: 8 }
const RANGE: Record<DetectedFrequency, [number, number]> = { weekly: [5, 9], biweekly: [12, 16], monthly: [26, 35], quarterly: [80, 100] }
export const MIN_OCCURRENCES = 3

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const mode = (xs: number[]) => { const c = new Map<number, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0] }

function classify(medianInterval: number): DetectedFrequency | null {
  for (const f of ['weekly', 'biweekly', 'monthly', 'quarterly'] as const) if (medianInterval >= RANGE[f][0] && medianInterval <= RANGE[f][1]) return f
  return null
}

/**
 * Groups by merchant and direction. A group is a regular payment when it happened at least three times, at a steady
 * interval (weekly, every two weeks, monthly or quarterly), for a steady amount, and is still going on. The amount rule
 * is what keeps groceries and fuel out: they recur often, but the amount changes every time.
 */
export function detectRecurring(txns: DetectTxn[], today: string): Detected[] {
  const groups = new Map<string, DetectTxn[]>()
  for (const t of txns) {
    if (!t.key || t.amountCents === 0) continue
    const g = `${t.direction}|${t.key}`
    ;(groups.get(g) ?? groups.set(g, []).get(g)!).push(t)
  }
  const out: Detected[] = []
  for (const list of groups.values()) {
    // one charge per day: two charges on the same day are not an interval
    const byDate = new Map<string, DetectTxn>()
    for (const t of [...list].sort((a, b) => a.date.localeCompare(b.date))) if (!byDate.has(t.date)) byDate.set(t.date, t)
    const rows = [...byDate.values()]
    if (rows.length < MIN_OCCURRENCES) continue
    const intervals = rows.slice(1).map((r, i) => daysBetween(rows[i]!.date, r.date))
    const freq = classify(median(intervals))
    if (!freq) continue
    const regular = intervals.filter((d) => Math.abs(d - PERIOD[freq]) <= TOLERANCE[freq]).length / intervals.length
    if (regular < 0.75) continue

    const direction = rows[0]!.direction
    const amounts = rows.map((r) => Math.abs(r.amountCents))
    const mid = median(amounts)
    const tol = Math.max(100, mid * (direction === 'income' ? 0.25 : 0.15))
    const steady = amounts.filter((a) => Math.abs(a - mid) <= tol).length / amounts.length
    if (steady < 0.8) continue

    const last = rows[rows.length - 1]!
    if (daysBetween(last.date, today) > PERIOD[freq] * 1.5 + 7) continue // it stopped a while ago: not a current bill
    out.push({
      key: last.key, direction, name: displayName(last.key), frequency: freq, amountCents: Math.abs(last.amountCents),
      accountId: mode(rows.map((r) => r.accountId)), occurrences: rows.length, firstDate: rows[0]!.date, lastDate: last.date,
      nextExpected: addDays(last.date, PERIOD[freq]),
      confidence: rows.length >= 4 && regular >= 0.9 && steady >= 0.95 ? 'high' : 'medium'
    })
  }
  return out.sort((a, b) => (a.direction === b.direction ? b.amountCents - a.amountCents : a.direction === 'income' ? -1 : 1))
}

/** Do two merchant keys name the same merchant? "NETFLIX.COM" and "NETFLIX" do; "UBER EATS" vs "NETFLIX" do not. */
export function sameMerchant(a: string, b: string): boolean {
  if (!a || !b) return false
  if (keyMatches(a, b) || keyMatches(b, a)) return true
  const first = (k: string) => /[A-Z]{4,}/.exec(k)?.[0] ?? ''
  return first(a) !== '' && first(a) === first(b)
}

/**
 * The merchant keys a tracked item's name could stand for: the name itself, a name in brackets ("Korean lessons (Jin Yu)"
 * is paid to JIN YU) and the payee in "e-transfer to Dad".
 */
export function nameKeys(name: string, normalize: (s: string) => string): string[] {
  const keys = [normalize(name)]
  const bracket = /\(([^)]+)\)/.exec(name)?.[1]
  if (bracket) keys.push(normalize(bracket))
  const payee = /e-?transfer\s+(?:to|from)\s+(.+)$/i.exec(name)?.[1]
  if (payee) keys.push(normalize(payee.replace(/[()].*$/, '')))
  return keys.filter(Boolean)
}

export interface TrackedItem {
  id: number
  name: string
  frequency: string
  lastSeen: string | null
  /** When the person last said "it is still active". Counts as having seen it. */
  checkedAt: string | null
  /** The latest date for which the account has any transactions: proof that the data reaches this far. */
  coverageEnd: string | null
}
export interface Stopped { id: number; name: string; lastSeen: string; expectedBy: string; missed: number }

/**
 * Tracked bills that have stopped appearing. A bill is only flagged when the account's data goes past the date it was
 * due, so a statement that simply has not been imported yet never causes a question.
 */
export function findStopped(items: TrackedItem[]): Stopped[] {
  const out: Stopped[] = []
  for (const it of items) {
    const period = PERIOD[it.frequency as keyof typeof PERIOD]
    if (!period || !it.coverageEnd) continue
    const seen = [it.lastSeen, it.checkedAt].filter((x): x is string => !!x).sort().pop()
    if (!seen) continue
    const grace = Math.max(5, Math.round(period * 0.25))
    const expected = addDays(seen, period)
    const missed = Math.floor(daysBetween(seen, it.coverageEnd) / period)
    const needed = period <= 15 ? 2 : 1
    if (it.coverageEnd > addDays(expected, grace) && missed >= needed) out.push({ id: it.id, name: it.name, lastSeen: it.lastSeen ?? seen, expectedBy: expected, missed })
  }
  return out
}
