// Builds the forecast from the person's own data: tracked recurring income and bills, the irregular income that shows
// up in the transactions, everyday spending by category, budgets, goals, debts and today's balances.
import type { Db } from './open'
import { addMonths, monthKey } from '../core/dates'
import { lastCompleteMonths, monthEnd, monthStart } from '../core/budgets'
import { monthlyCostCents, type Frequency } from '../core/recurring'
import { normalizeKey } from '../core/normalize'
import { nameKeys, sameMerchant } from '../core/recurringDetect'
import { refundedItemIds } from './recurringDetect'
import { applyWhatIf, emptyWhatIf, projectForecast, type ExpenseLine, type ForecastInput, type ForecastResult, type GoalSaving, type IncomeStream, type WhatIf } from '../core/forecast'
import { listBudgets } from './budgets'
import { listGoals } from './goals'
import { accountValueCents } from './review'
import { getPlanner, scopeOf, type PlannerState } from './debtPlan'
import { toPlanDebts } from './forecastDebts'

export const DEFAULT_MONTHS = 24
const SMALL_CENTS = 1000 // categories averaging under $10 a month are grouped as "other small spending"
const whatIfKey = (profileId: number) => `forecast_whatif_${profileId}`

export interface ForecastView {
  startMonth: string
  months: number
  /** The history the numbers come from. */
  basedOnMonths: string[]
  inputs: { current: ForecastInput; plan: ForecastInput }
  current: ForecastResult
  plan: ForecastResult
  whatIf: ForecastResult | null
  whatIfInput: ForecastInput | null
  savedWhatIf: WhatIf | null
  planner: PlannerState
  notes: string[]
}

interface Tracked { id: number; name: string; direction: 'income' | 'expense'; amountCents: number; frequency: string; matchKey: string | null; counts: number }

const monthlyOf = (t: { amountCents: number; frequency: string }) => monthlyCostCents(t.amountCents, t.frequency as Frequency)
const stdev = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) }

export function loadSavedWhatIf(db: Db, profileId: number): WhatIf | null {
  const raw = (db.prepare('SELECT value FROM setting WHERE key = ?').get(whatIfKey(profileId)) as { value: string } | undefined)?.value
  if (!raw) return null
  try { const v = JSON.parse(raw) as WhatIf; return v && typeof v === 'object' && Array.isArray(v.lines) && Array.isArray(v.added) ? v : null } catch { return null }
}

export function saveWhatIf(db: Db, profileId: number, w: WhatIf | null): void {
  if (w === null) { db.prepare('DELETE FROM setting WHERE key = ?').run(whatIfKey(profileId)); return }
  const num = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi
  if (!num(w.incomePct, -100, 1000) || !num(w.spendPct, -100, 1000) || !num(w.extraDebtCents, 0, 1e10) || !num(w.months, 1, 120)) throw new Error('Some of the what-if numbers are out of range')
  if (w.added.length > 50 || w.lines.length > 200 || w.oneTime.length > 50) throw new Error('Too many what-if items')
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(whatIfKey(profileId), JSON.stringify(w))
}

/** The two forecasts that need no input from the person, plus the what-if if one is given (or saved). */
export function getForecast(db: Db, profileId: number, today: string, opts: { months?: number; whatIf?: WhatIf | null } = {}): ForecastView {
  const { ids } = scopeOf(db, profileId)
  const marks = ids.map(() => '?').join(',')
  const months = Math.min(120, Math.max(1, Math.round(opts.months ?? DEFAULT_MONTHS)))
  const startMonth = addMonths(monthKey(today), 1)
  const notes: string[] = []

  // ---- history windows (complete months with any data) ----
  const hasData = (m: string) => !!db.prepare(`SELECT 1 FROM txn WHERE profile_id IN (${marks}) AND kind IN ('income','expense','refund') AND posted_date BETWEEN ? AND ? LIMIT 1`).get(...ids, monthStart(m), monthEnd(m))
  const incomeMonths = lastCompleteMonths(today, 6).filter(hasData)
  const spendMonths = lastCompleteMonths(today, 3).filter(hasData)
  if (spendMonths.length === 0) notes.push('There is not enough history yet (no complete month of transactions), so income and spending start at zero. Import a month or two of transactions first.')

  // ---- tracked recurring items ----
  const refundedIds = new Set(ids.flatMap((i) => [...refundedItemIds(db, i, today)]))
  const tracked = (db.prepare(`SELECT id, name, direction, amount_cents AS amountCents, frequency, match_key AS matchKey, counts_in_budget AS counts FROM recurring WHERE profile_id IN (${marks}) AND status IN ('active','new','updated') AND frequency != 'irregular'`).all(...ids) as Tracked[]).filter((t) => !refundedIds.has(t.id))
  const keysOf = (t: Tracked) => (t.matchKey ? [t.matchKey] : nameKeys(t.name, normalizeKey))

  // ---- income ----
  const income: IncomeStream[] = []
  const trackedIncome = tracked.filter((t) => t.direction === 'income')
  for (const t of trackedIncome) income.push({ id: `inc:${t.id}`, label: t.name, kind: 'regular', monthlyCents: monthlyOf(t), lowCents: monthlyOf(t), highCents: monthlyOf(t) })

  const incomeRows = incomeMonths.length === 0 ? [] : db.prepare(`SELECT t.posted_date AS date, t.amount_cents AS cents, COALESCE(pc.name, c.name, 'Other income') AS category, COALESCE(t.description_raw, t.description) AS text
    FROM txn t LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category pc ON pc.id = c.parent_id WHERE t.profile_id IN (${marks}) AND t.kind = 'income' AND t.posted_date BETWEEN ? AND ?`).all(...ids, monthStart(incomeMonths[0]!), monthEnd(incomeMonths[incomeMonths.length - 1]!)) as { date: string; cents: number; category: string; text: string }[]
  const byCat = new Map<string, number[]>()
  for (const r of incomeRows) {
    const key = normalizeKey(r.text)
    if (trackedIncome.some((t) => keysOf(t).some((k) => sameMerchant(key, k)))) continue // already counted as a tracked item
    const idx = incomeMonths.indexOf(monthKey(r.date))
    if (idx < 0) continue
    const arr = byCat.get(r.category) ?? new Array<number>(incomeMonths.length).fill(0)
    arr[idx]! += r.cents
    byCat.set(r.category, arr)
  }
  for (const [name, arr] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
    if (avg < 500) continue
    // steady (nearly every month, small swings) = regular; otherwise irregular and shown with a range
    const steady = arr.filter((v) => v > 0).length >= Math.max(2, arr.length - 1) && stdev(arr) / avg < 0.3
    income.push({ id: `inc-cat:${name}`, label: name, kind: steady ? 'regular' : 'irregular', monthlyCents: avg, lowCents: steady ? avg : Math.min(...arr), highCents: steady ? avg : Math.max(...arr) })
  }

  // ---- spending: tracked bills + everyday spending by category (average of the last three complete months) ----
  const bills: ExpenseLine[] = tracked.filter((t) => t.direction === 'expense' && t.counts).map((t) => ({ id: `bill:${t.id}`, label: t.name, kind: 'bill' as const, monthlyCents: monthlyOf(t) }))
  const spendRows = spendMonths.length === 0 ? [] : db.prepare(`SELECT t.posted_date AS date, t.amount_cents AS cents, t.kind, COALESCE(pc.name, c.name, 'Uncategorized') AS category, COALESCE(t.description_raw, t.description) AS text
    FROM txn t LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category pc ON pc.id = c.parent_id WHERE t.profile_id IN (${marks}) AND t.kind IN ('expense','refund') AND t.posted_date BETWEEN ? AND ?`).all(...ids, monthStart(spendMonths[0]!), monthEnd(spendMonths[spendMonths.length - 1]!)) as { date: string; cents: number; kind: string; category: string; text: string }[]
  const catTotal = new Map<string, number>()
  for (const r of spendRows) catTotal.set(r.category, (catTotal.get(r.category) ?? 0) - r.cents)
  const catAvg = new Map([...catTotal].map(([k, v]) => [k, Math.max(0, Math.round(v / Math.max(1, spendMonths.length)))]))
  // a bill is already inside its category's average: take it out of the category so it is not counted twice
  for (const b of tracked.filter((t) => t.direction === 'expense' && t.counts)) {
    const hit = spendRows.filter((r) => r.kind === 'expense' && keysOf(b).some((k) => sameMerchant(normalizeKey(r.text), k))).sort((x, y) => y.date.localeCompare(x.date))[0]
    if (hit) catAvg.set(hit.category, Math.max(0, (catAvg.get(hit.category) ?? 0) - monthlyOf(b)))
  }
  const everydayAll: ExpenseLine[] = []
  let small = 0
  for (const [name, avg] of [...catAvg.entries()].sort((a, b) => b[1] - a[1])) {
    if (avg <= 0) continue
    if (avg < SMALL_CENTS) { small += avg; continue }
    everydayAll.push({ id: `cat:${name}`, label: name, kind: 'everyday', monthlyCents: avg })
  }
  if (small > 0) everydayAll.push({ id: 'cat:__small', label: 'Other small spending', kind: 'everyday', monthlyCents: small })

  // ---- plan: budgets cap the categories they cover (a person's own budgets; the household has none of its own here) ----
  const planEveryday = everydayAll.map((e) => ({ ...e }))
  if (ids.length === 1) {
    const matchedBillByCat = new Map<string, number>()
    for (const b of tracked.filter((t) => t.direction === 'expense' && t.counts)) {
      const hit = spendRows.filter((r) => r.kind === 'expense' && keysOf(b).some((k) => sameMerchant(normalizeKey(r.text), k))).sort((x, y) => y.date.localeCompare(x.date))[0]
      if (hit) matchedBillByCat.set(hit.category, (matchedBillByCat.get(hit.category) ?? 0) + monthlyOf(b))
    }
    const names = new Map((db.prepare('SELECT c.id, COALESCE(pc.name, c.name) AS name FROM category c LEFT JOIN category pc ON pc.id = c.parent_id WHERE c.profile_id = ?').all(ids[0]!) as { id: number; name: string }[]).map((c) => [c.id, c.name]))
    for (const b of listBudgets(db, ids[0]!)) {
      const cats = b.categoryIds.map((id) => names.get(id)!).filter(Boolean)
      const everyday = planEveryday.filter((e) => cats.includes(e.id.slice(4)))
      const a = everyday.reduce((s, e) => s + e.monthlyCents, 0)
      const billsHere = cats.reduce((s, c) => s + (matchedBillByCat.get(c) ?? 0), 0)
      const target = Math.max(0, b.monthlyCents - billsHere)
      if (a > target && a > 0) { const f = target / a; for (const e of everyday) e.monthlyCents = Math.round(e.monthlyCents * f) }
    }
  }

  // ---- goals: money set aside each month until the goal is reached ----
  const goals: GoalSaving[] = ids.flatMap((i) => listGoals(db, i, today)).filter((g) => (g.kind === 'manual' || g.kind === 'account') && (g.plannedMonthlyCents ?? 0) > 0 && g.progress.remainingCents > 0)
    .map((g) => ({ id: `goal:${g.id}`, label: g.name, monthlyCents: g.plannedMonthlyCents!, remainingCents: g.progress.remainingCents }))

  // ---- balances ----
  const accts = db.prepare(`SELECT id, type FROM account WHERE profile_id IN (${marks}) AND archived = 0 AND type IN ('chequing','savings','cash','investment')`).all(...ids) as { id: number; type: string }[]
  let cash = 0
  let invest = 0
  for (const a of accts) { const v = accountValueCents(db, a.id); if (v === null) continue; if (a.type === 'investment') invest += v; else cash += v }

  // ---- debts and the payoff plan ----
  const planner = getPlanner(db, profileId, today)
  const planDebts = toPlanDebts(planner)
  const minimums = planDebts.reduce((s, d) => s + Math.min(d.balanceCents, d.minPaymentCents), 0)

  const common = { startMonth, months, startCashCents: cash, startInvestmentsCents: invest, debts: planDebts, income }
  const current: ForecastInput = { ...common, strategy: 'minimum', debtBudgetCents: minimums, expenses: [...bills, ...everydayAll], goals: [] }
  const plan: ForecastInput = { ...common, strategy: planner.strategy, debtBudgetCents: planner.monthlyBudgetCents, expenses: [...bills, ...planEveryday], goals }

  const saved = loadSavedWhatIf(db, profileId)
  const w = opts.whatIf === undefined ? saved : opts.whatIf
  const whatIfInput = w ? applyWhatIf(w.base === 'current' ? current : plan, { ...w, months }) : null

  if (income.length === 0) notes.push('No income was found in the last six complete months, so the forecast shows spending with nothing coming in. Import your income transactions, or add an income line in the what-if.')
  return {
    startMonth, months, basedOnMonths: [...new Set([...incomeMonths, ...spendMonths])].sort(), inputs: { current, plan },
    current: projectForecast(current), plan: projectForecast(plan), whatIf: whatIfInput ? projectForecast(whatIfInput) : null, whatIfInput, savedWhatIf: saved, planner, notes
  }
}

export { emptyWhatIf }
