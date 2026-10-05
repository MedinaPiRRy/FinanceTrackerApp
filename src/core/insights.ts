import { addMonths } from './dates'
import { formatCents } from './money'
import type { MonthSummary } from './summary'
import type { GoalProgress } from './goals'

export type InsightType = 'fact' | 'trend' | 'anomaly' | 'recommendation'
/** Where an insight points: the page to open and what to filter it by, so "click and see what it means" lands on the evidence. */
export interface InsightRef {
  page: 'transactions' | 'budget' | 'goals' | 'recurring' | 'forecast' | 'accounts'
  category?: string
  month?: string
  text?: string
  budget?: string
  goal?: string
  /** One specific transaction (with its account and date) so the page can open right on it. */
  txnId?: number
  accountId?: number
  date?: string
}
export interface Insight {
  /** Stable across reloads (derived from the text), so a dismissed tip stays dismissed. */
  id?: string
  type: InsightType
  tone: 'neutral' | 'good' | 'warn'
  title: string
  detail?: string
  /** A plain-language explanation of why this matters, in a gentle tone. */
  meaning?: string
  ref?: InsightRef
}

export interface InsightTxn {
  id?: number
  accountId?: number
  date: string
  amountCents: number
  kind: string
  category: string | null
  description: string
}

export interface InsightInput {
  month: string
  /** Every month that has data, ascending. */
  series: MonthSummary[]
  txns: InsightTxn[]
  /** Monthly cost of active recurring bills that count toward the budget. */
  recurringMonthlyCents: number
  /** Budget lines for the selected month (optional). */
  budgets?: { name: string; budgetCents: number; spentCents: number; projectedCents?: number | null }[]
  goals?: { name: string; deadline: string | null; plannedMonthlyCents: number | null; progress: GoalProgress }[]
  /** Credit cards that have a limit entered. */
  cards?: { name: string; owedCents: number; limitCents: number }[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return `${MONTHS[mo - 1]} ${y}`
}
const pct = (n: number) => `${Math.round(n * 100)}%`
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const std = (xs: number[]) => {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const h = Math.floor(s.length / 2)
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2
}

/**
 * Insights are computed only from the person's own recorded data. They describe what happened; the
 * "recommendation" type only points at something worth a look and never gives financial advice.
 */
export function generateInsights(input: InsightInput): Insight[] {
  const { month, series, txns, recurringMonthlyCents } = input
  const out: Insight[] = []
  const cur = series.find((s) => s.month === month)
  if (!cur) return out
  const prev = series.find((s) => s.month === addMonths(month, -1))
  const prior = series.filter((s) => s.month < month)
  const label = monthLabel(month)

  // ---- facts ----
  const cats = Object.entries(cur.byCategory).sort((a, b) => b[1] - a[1])
  if (cats.length && cur.expenseCents > 0) {
    const [name, cents] = cats[0]!
    out.push({ type: 'fact', tone: 'neutral', title: `Your largest spending category in ${label} is ${name}`, detail: `${formatCents(cents)}, ${pct(cents / cur.expenseCents)} of the month's spending.` , meaning: 'This is where most of your money went this month. When you want to spend less overall, the biggest category is usually where a small change makes the largest difference.', ref: { page: 'transactions', category: name, month } })
  }
  if (cur.incomeCents > 0 || cur.expenseCents > 0) {
    if (cur.netCents < 0) out.push({ type: 'fact', tone: 'warn', title: `Recorded spending exceeded recorded income by ${formatCents(-cur.netCents)} in ${label}`, detail: `${formatCents(cur.expenseCents)} spent vs ${formatCents(cur.incomeCents)} income. Money from savings, cards or unreviewed transactions is not counted as income.` , meaning: 'Money going out was more than money coming in this month, so savings shrank or a balance grew. One month can be a one-off (a big purchase, an annual bill), so look at the transactions before drawing a conclusion.', ref: { page: 'transactions', month } })
    else out.push({ type: 'fact', tone: 'good', title: `You kept ${formatCents(cur.netCents)} of ${formatCents(cur.incomeCents)} recorded income in ${label}`, detail: cur.savingsRate !== null ? `Savings rate ${pct(cur.savingsRate)}.` : undefined , meaning: 'This is what was left after spending. Higher is better, but there is no single right number: it depends on your goals.', ref: { page: 'transactions', month } })
  }
  const last6 = series.filter((s) => s.month <= month).slice(-6)
  if (last6.length >= 3) out.push({ type: 'fact', tone: 'neutral', title: `Average monthly net over the last ${last6.length} months: ${formatCents(Math.round(mean(last6.map((s) => s.netCents))))}`, detail: 'Net = recorded income minus recorded spending.' , meaning: 'The average of what you kept (income minus spending) over recent months. The Forecast uses this pace to show where you are heading.', ref: { page: 'forecast' } })

  const incomeBase = prior.length ? mean(prior.map((s) => s.incomeCents)) : cur.incomeCents
  if (recurringMonthlyCents > 0 && incomeBase > 0)
    out.push({ type: 'fact', tone: 'neutral', title: `Recurring bills are about ${pct(recurringMonthlyCents / incomeBase)} of your average monthly income`, detail: `${formatCents(recurringMonthlyCents)} a month in active recurring bills against ${formatCents(Math.round(incomeBase))} average income.` , meaning: 'Bills that repeat every month are the part of your spending that is hardest to change quickly, so a smaller share leaves you more room to adjust.', ref: { page: 'recurring' } })

  // ---- trends ----
  if (prev) {
    const moves: { name: string; delta: number; ratio: number }[] = []
    for (const [name, c] of Object.entries(cur.byCategory)) {
      const p = prev.byCategory[name] ?? 0
      if (p > 0) moves.push({ name, delta: c - p, ratio: (c - p) / p })
    }
    for (const m of moves.filter((x) => Math.abs(x.delta) >= 5000 && Math.abs(x.ratio) >= 0.25).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3))
      out.push({ type: 'trend', tone: m.delta > 0 ? 'warn' : 'good', title: `${m.name} spending ${m.delta > 0 ? 'rose' : 'fell'} ${pct(Math.abs(m.ratio))} compared with ${monthLabel(prev.month)}`, detail: `${m.delta > 0 ? '+' : '-'}${formatCents(Math.abs(m.delta))} month over month.` , meaning: 'Compared with last month, this category moved a lot. Open it to see which purchases made the difference.', ref: { page: 'transactions', category: m.name, month } })
  }
  let streak = 0
  for (let i = series.findIndex((s) => s.month === month); i > 0; i--) {
    if (series[i]!.expenseCents > series[i - 1]!.expenseCents && series[i]!.month === addMonths(series[i - 1]!.month, 1)) streak++
    else break
  }
  if (streak >= 3) out.push({ type: 'trend', tone: 'warn', title: `Your spending has increased for ${streak} consecutive months`, detail: `Up to ${formatCents(cur.expenseCents)} in ${label}.` , meaning: 'Spending has crept up month after month. That is not a problem by itself, but it is worth checking whether a few big items or lots of small ones explain it.', ref: { page: 'transactions', month } })

  // ---- anomalies ----
  if (prior.length >= 4) {
    const xs = prior.map((s) => s.expenseCents)
    const m = mean(xs)
    const sd = std(xs)
    if (sd > 0 && cur.expenseCents > m + 1.5 * sd)
      out.push({ type: 'anomaly', tone: 'warn', title: `${label} spending is unusually high compared with your history`, detail: `${formatCents(cur.expenseCents)} vs a typical ${formatCents(Math.round(m))} (${formatCents(cur.expenseCents - Math.round(m))} above).` , meaning: 'This month is well above your usual range. Often one large purchase explains it.', ref: { page: 'transactions', month } })
  }
  const byCat = new Map<string, number[]>()
  for (const t of txns) if (t.kind === 'expense' && t.category && t.date < `${month}-01`) (byCat.get(t.category) ?? byCat.set(t.category, []).get(t.category)!).push(-t.amountCents)
  const unusual = txns
    .filter((t) => t.kind === 'expense' && t.category && t.date.startsWith(month) && -t.amountCents >= 7500)
    .map((t) => ({ t, hist: byCat.get(t.category!) ?? [] }))
    .filter(({ t, hist }) => hist.length >= 5 && -t.amountCents >= 3 * median(hist))
    .sort((a, b) => a.t.amountCents - b.t.amountCents)
    .slice(0, 3)
  for (const { t, hist } of unusual)
    out.push({ type: 'anomaly', tone: 'warn', title: `Unusually large ${t.category} purchase: ${t.description}`, detail: `${formatCents(-t.amountCents)} on ${t.date}; your typical ${t.category} transaction is ${formatCents(Math.round(median(hist)))}.` , meaning: 'One purchase far larger than usual for this category. If you expected it, there is nothing to do; if not, it is worth checking it is correct.', ref: { page: 'transactions', category: t.category!, month, text: t.description, txnId: t.id, accountId: t.accountId, date: t.date } })

  // ---- recommendations (point at something to look at, no advice) ----
  const window = series.filter((s) => s.month <= month).slice(-6)
  const deficits = window.filter((s) => s.incomeCents > 0 && s.netCents < 0)
  if (window.length >= 4 && deficits.length >= Math.ceil(window.length / 2)) {
    const top = Object.entries(cur.byCategory).sort((a, b) => b[1] - a[1])[0]
    out.push({ type: 'recommendation', tone: 'warn', title: `Spending exceeded recorded income in ${deficits.length} of the last ${window.length} months`, detail: top ? `Worth reviewing ${top[0]}, your largest category this month, and confirming income and transfers are recorded correctly.` : undefined , meaning: 'Over several months you spent more than you recorded earning. First check whether some income is missing from your records (cash, side work), then look at the biggest categories.', ref: { page: 'transactions', month } })
  }
  if (input.budgets) out.push(...budgetInsights(input.budgets))
  if (input.goals) out.push(...goalInsights(input.goals))
  if (input.cards) out.push(...cardInsights(input.cards))
  return out.map((i) => ({ ...i, id: i.id ?? `${i.type}:${i.title.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().slice(0, 80)}` }))
}

export function budgetInsights(lines: NonNullable<InsightInput['budgets']>): Insight[] {
  const out: Insight[] = []
  const over = lines.filter((l) => l.spentCents > l.budgetCents).sort((a, b) => b.spentCents - b.budgetCents - (a.spentCents - a.budgetCents)).slice(0, 3)
  for (const l of over) {
    const by = l.spentCents - l.budgetCents
    out.push({ type: 'fact', tone: 'warn', title: `${l.name} is ${formatCents(by)} over budget`, detail: l.budgetCents > 0 ? `${formatCents(l.spentCents)} spent against a ${formatCents(l.budgetCents)} budget (${pct(by / l.budgetCents)} over).` : `${formatCents(l.spentCents)} spent against a $0 budget.` , meaning: 'You spent more than the limit you set. Either the limit was tight or this month was unusual. The Budget page shows which categories drove it.', ref: { page: 'budget', budget: l.name } })
  }
  const near = lines.filter((l) => l.budgetCents > 0 && l.spentCents <= l.budgetCents && l.spentCents / l.budgetCents >= 0.85).slice(0, 2)
  for (const l of near) out.push({ type: 'fact', tone: 'warn', title: `${l.name} is at ${pct(l.spentCents / l.budgetCents)} of its budget`, detail: `${formatCents(l.budgetCents - l.spentCents)} left.` , meaning: 'You are close to the limit with part of the month left. Slowing down a little keeps you inside it.', ref: { page: 'budget', budget: l.name } })
  const under = lines.filter((l) => l.budgetCents > 0 && l.budgetCents - l.spentCents >= 5000 && l.spentCents / l.budgetCents < 0.85 && !(l.projectedCents != null && l.projectedCents > l.budgetCents)).sort((a, b) => b.budgetCents - b.spentCents - (a.budgetCents - a.spentCents)).slice(0, 2)
  for (const l of under) out.push({ type: 'fact', tone: 'good', title: `You are ${formatCents(l.budgetCents - l.spentCents)} below your ${l.name} budget` , meaning: 'You have room left in this budget. Nothing to do; it is a nice buffer.', ref: { page: 'budget', budget: l.name } })
  const proj = lines.filter((l) => l.budgetCents > 0 && l.projectedCents != null && l.spentCents <= l.budgetCents && l.projectedCents > l.budgetCents).slice(0, 2)
  for (const l of proj) out.push({ type: 'trend', tone: 'warn', title: `${l.name} is on pace to go over budget this month`, detail: `At the current pace it would reach about ${formatCents(l.projectedCents!)} against a ${formatCents(l.budgetCents)} budget.` , meaning: 'Spending so far is running ahead of the month. If the pace continues you will finish above the limit, so there is still time to ease off.', ref: { page: 'budget', budget: l.name } })
  return out
}

/** Lenders commonly treat a balance above about 30% of the limit as high. */
export const HIGH_UTILISATION = 0.3

export function cardInsights(cards: NonNullable<InsightInput['cards']>): Insight[] {
  return cards
    .filter((c) => c.limitCents > 0 && c.owedCents / c.limitCents >= HIGH_UTILISATION)
    .sort((a, b) => b.owedCents / b.limitCents - a.owedCents / a.limitCents)
    .slice(0, 2)
    .map((c) => ({
      type: 'fact' as const, tone: 'warn' as const,
      title: `${c.name} is using ${pct(c.owedCents / c.limitCents)} of its credit limit`,
      detail: `${formatCents(c.owedCents)} owed against a ${formatCents(c.limitCents)} limit.`,
      meaning: 'Lenders commonly treat a balance above about 30% of the limit as high. A lower balance can help your credit score and leaves more room for emergencies.',
      ref: { page: 'accounts' as const }
    }))
}

export function goalInsights(goals: NonNullable<InsightInput['goals']>): Insight[] {
  const out: Insight[] = []
  for (const g of goals) {
    const p = g.progress
    if (p.status === 'achieved') out.push({ type: 'fact', tone: 'good', title: `You have reached your goal: ${g.name}` , meaning: 'You hit the target you set. You can set a new goal or raise this one.', ref: { page: 'goals', goal: g.name } })
    else if (p.status === 'no_value') out.push({ type: 'recommendation', tone: 'neutral', title: `Enter the current value to track "${g.name}"`, detail: 'There is no balance recorded yet, so progress cannot be shown.' , meaning: 'A goal that follows an account needs a current value before it can show progress.', ref: { page: 'goals', goal: g.name } })
    else if (p.status === 'on_track' && p.estimatedMonth) out.push({ type: 'trend', tone: 'good', title: `You are on pace to reach "${g.name}" by ${monthLabel(p.estimatedMonth)}`, detail: g.deadline ? `Deadline ${monthLabel(g.deadline.slice(0, 7))}. At ${formatCents(g.plannedMonthlyCents ?? 0)} a month.` : undefined , meaning: 'At the planned monthly amount you finish before your deadline.', ref: { page: 'goals', goal: g.name } })
    else if (p.status === 'behind') out.push({ type: 'trend', tone: 'warn', title: p.estimatedMonth ? `At the planned amount, "${g.name}" would be reached in ${monthLabel(p.estimatedMonth)}, after your deadline` : `"${g.name}" has a deadline but no monthly amount planned`, detail: p.requiredMonthlyCents ? `To finish on time you would need about ${formatCents(p.requiredMonthlyCents)} a month.` : undefined , meaning: 'At the planned monthly amount you would finish after your deadline. Raising the monthly amount or moving the deadline closes the gap.', ref: { page: 'goals', goal: g.name } })
    else if (p.status === 'overdue') out.push({ type: 'fact', tone: 'warn', title: `"${g.name}" is past its deadline`, detail: `${formatCents(p.remainingCents)} still to go.` , meaning: 'The deadline has passed. Consider moving it or topping up the goal.', ref: { page: 'goals', goal: g.name } })
    else if (p.status === 'no_deadline' && p.estimatedMonth) out.push({ type: 'trend', tone: 'neutral', title: `At ${formatCents(g.plannedMonthlyCents ?? 0)} a month, you would reach "${g.name}" around ${monthLabel(p.estimatedMonth)}`, detail: `${formatCents(p.remainingCents)} still to go.` , meaning: 'There is no deadline, so this shows when the planned monthly amount would finish the goal.', ref: { page: 'goals', goal: g.name } })
  }
  return out
}

/**
 * The one tip worth showing when the app opens. Gentle by design: something that needs a look comes first (but only
 * one, and never a wall of warnings), otherwise something encouraging. Returns null when there is nothing to say.
 */
export function pickBannerTip(insights: Insight[], skipIds: string[] = []): Insight | null {
  const fresh = insights.filter((i) => i.id && !skipIds.includes(i.id))
  const rank = (i: Insight) => (i.tone === 'warn' ? (i.type === 'anomaly' ? 0 : i.type === 'trend' ? 1 : i.type === 'recommendation' ? 2 : 3) : i.tone === 'good' ? 4 : 5)
  return [...fresh].filter((i) => i.tone !== 'neutral' || i.type === 'recommendation').sort((a, b) => rank(a) - rank(b))[0] ?? null
}
