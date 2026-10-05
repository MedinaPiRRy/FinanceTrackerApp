// Goal ideas from a person's (or a household's) real numbers. Pure and deterministic. Every idea explains why it is
// suggested, and the monthly amount is capped at a share of what is actually left over each month, so none of them
// asks for money the person does not have.
import { addMonths, monthKey } from './dates'
import { monthEnd } from './budgets'

export interface IdeaInput {
  today: string
  /** Average over recent complete months. Null when there is not enough history to know. */
  avgMonthlySpendCents: number | null
  avgMonthlyIncomeCents: number | null
  /** Accounts a goal can track (savings-type), with their current value. */
  savingsAccounts: { id: number; name: string; valueCents: number | null }[]
  /** Cash that counts toward an emergency cushion (savings value, including ones that cannot be tracked by a goal). */
  cushionCents: number
  investments: { id: number; name: string; valueCents: number | null }[]
  cards: { accountId: number; name: string; owedCents: number }[]
  loans: { debtId: number; name: string; balanceCents: number }[]
  existing: {
    emergency: boolean
    cardIds: number[] // cards already inside a payoff goal
    loanIds: number[]
    accountIds: number[] // accounts already tracked by a goal
    savingHabit: boolean
  }
}

export interface GoalIdea {
  key: string
  title: string
  kind: 'manual' | 'account' | 'debt'
  why: string
  targetCents?: number
  accountId?: number
  debtItems?: { accountId?: number; debtId?: number }[]
  /** Suggested monthly amount; null when nothing is left over to commit. */
  plannedMonthlyCents: number | null
  deadline: string | null
  monthsToFinish: number | null
  /** 'comfortable' = well inside what is left over each month; 'stretch' = needs most of it. */
  tone: 'comfortable' | 'stretch' | 'unknown'
  notes: string
}

const STEP = 500 // $5
const roundUp = (c: number, step = STEP) => Math.ceil(c / step) * step
const roundDown = (c: number, step = STEP) => Math.floor(c / step) * step
/** Share of the monthly surplus that may be committed to goals in total. The rest is left as breathing room. */
export const SURPLUS_SHARE = 0.6

function plan(remaining: number, months: number, pool: number): { planned: number | null; used: number; months: number | null } {
  if (pool < STEP) return { planned: null, used: 0, months: null }
  const wanted = roundUp(Math.ceil(remaining / months))
  const planned = Math.max(STEP, Math.min(wanted, roundDown(pool)))
  return { planned, used: planned, months: Math.ceil(remaining / planned) }
}

export function suggestIdeas(i: IdeaInput): GoalIdea[] {
  const out: GoalIdea[] = []
  const spend = i.avgMonthlySpendCents
  const surplus = i.avgMonthlyIncomeCents !== null && spend !== null ? i.avgMonthlyIncomeCents - spend : null
  let pool = surplus !== null && surplus > 0 ? Math.round(surplus * SURPLUS_SHARE) : 0
  const money = (c: number) => `$${(c / 100).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  const finish = (months: number | null) => (months === null ? null : monthEnd(addMonths(monthKey(i.today), months - 1)))
  const toneOf = (used: number, before: number): GoalIdea['tone'] => (surplus === null ? 'unknown' : used === 0 ? 'unknown' : used > before * 0.7 ? 'stretch' : 'comfortable')
  const surplusNote = surplus === null ? 'There is not enough history to know how much is left over each month, so the monthly amount is left for you to set.'
    : surplus <= 0 ? 'Spending matched or beat income in recent months, so no monthly amount is suggested yet. Even a small regular amount helps.'
    : `Based on about ${money(surplus)} left over each month; at most ${Math.round(SURPLUS_SHARE * 100)}% of that is committed to goals.`

  // 1. Pay off cards first: they cost the most.
  const cards = i.cards.filter((c) => c.owedCents > 0 && !i.existing.cardIds.includes(c.accountId))
  if (cards.length > 0) {
    const owed = cards.reduce((s, c) => s + c.owedCents, 0)
    const p = plan(owed, 12, Math.round(pool * 0.6))
    pool -= p.used
    out.push({
      key: 'cards', title: cards.length === 1 ? `Pay off ${cards[0]!.name}` : 'Pay off your credit cards', kind: 'debt',
      why: `You owe ${money(owed)} on ${cards.length === 1 ? cards[0]!.name : `${cards.length} cards`}. Card interest is usually the most expensive money you have, so clearing it is the best first goal. ${p.planned ? `${money(p.planned)} a month clears it in about ${p.months} month${p.months === 1 ? '' : 's'}.` : ''}`,
      debtItems: cards.map((c) => ({ accountId: c.accountId })), plannedMonthlyCents: p.planned, deadline: finish(p.months), monthsToFinish: p.months, tone: toneOf(p.used, Math.round((surplus ?? 0) * SURPLUS_SHARE)),
      notes: `Suggested by the app. ${surplusNote}`
    })
  }

  // 2. An emergency cushion: one month of spending first, then three.
  if (!i.existing.emergency && spend !== null && spend > 0) {
    const month = roundUp(spend, 10000)
    const target = i.cushionCents < spend ? month : roundUp(spend * 3, 10000)
    if (i.cushionCents < target) {
      const label = target === month ? 'Starter emergency fund (1 month)' : 'Emergency fund (3 months)'
      const tracked = i.savingsAccounts.filter((a) => !i.existing.accountIds.includes(a.id)).sort((a, b) => (b.valueCents ?? 0) - (a.valueCents ?? 0))[0]
      const have = tracked ? tracked.valueCents ?? 0 : 0
      const p = plan(Math.max(0, target - have), 12, Math.round(pool * 0.6))
      pool -= p.used
      out.push({
        key: 'emergency', title: label, kind: tracked ? 'account' : 'manual', targetCents: target, accountId: tracked?.id,
        why: `You spend about ${money(spend)} a month. ${target === month ? 'A first goal is one month of spending set aside' : 'Three months of spending set aside'} (${money(target)}) so a surprise bill or a gap in income does not go on a card.${tracked ? ` It tracks ${tracked.name}, which holds ${money(have)} now.` : ' You have no savings account to track, so you would add to it yourself; a separate savings account keeps it out of everyday spending.'}${p.planned ? ` ${money(p.planned)} a month gets there in about ${p.months} month${p.months === 1 ? '' : 's'}.` : ''}`,
        plannedMonthlyCents: p.planned, deadline: finish(p.months), monthsToFinish: p.months, tone: toneOf(p.used, Math.round((surplus ?? 0) * SURPLUS_SHARE)),
        notes: `Suggested by the app. ${surplusNote}`
      })
    }
  }

  // 3. Loans, over two years.
  const loans = i.loans.filter((l) => l.balanceCents > 0 && !i.existing.loanIds.includes(l.debtId))
  if (loans.length > 0) {
    const owed = loans.reduce((s, l) => s + l.balanceCents, 0)
    const p = plan(owed, 24, pool)
    pool -= p.used
    out.push({
      key: 'loans', title: loans.length === 1 ? `Pay down ${loans[0]!.name}` : 'Pay down your loans', kind: 'debt',
      why: `${money(owed)} is owed on ${loans.length === 1 ? loans[0]!.name : `${loans.length} loans`}. Spread over two years that is about ${money(roundUp(Math.ceil(owed / 24)))} a month.${p.planned ? ` With what is left over, ${money(p.planned)} a month finishes in about ${p.months} month${p.months === 1 ? '' : 's'}.` : ''}`,
      debtItems: loans.map((l) => ({ debtId: l.debtId })), plannedMonthlyCents: p.planned, deadline: finish(p.months), monthsToFinish: p.months, tone: toneOf(p.used, Math.round((surplus ?? 0) * SURPLUS_SHARE)),
      notes: `Suggested by the app. ${surplusNote}`
    })
  }

  // 4. Grow an investment account that no goal looks at.
  const inv = i.investments.filter((a) => !i.existing.accountIds.includes(a.id) && a.valueCents !== null && a.valueCents > 0)[0]
  if (inv && pool >= 2 * STEP) {
    const planned = Math.max(STEP, roundDown(Math.round(pool * 0.5)))
    const target = roundUp(inv.valueCents! + planned * 12, 100000)
    pool -= planned
    out.push({
      key: `invest:${inv.id}`, title: `Grow ${inv.name}`, kind: 'account', accountId: inv.id, targetCents: target,
      why: `${inv.name} is worth ${money(inv.valueCents!)} (the value you entered). Adding ${money(planned)} a month for a year, plus any market growth, gets it to about ${money(target)}. Update the value from time to time so the progress stays true.`,
      plannedMonthlyCents: planned, deadline: finish(Math.ceil((target - inv.valueCents!) / planned)), monthsToFinish: Math.ceil((target - inv.valueCents!) / planned), tone: 'comfortable',
      notes: `Suggested by the app. ${surplusNote}`
    })
  }

  // 5. A savings habit when nothing else is asking for the money.
  if (!i.existing.savingHabit && out.length === 0 && surplus !== null && surplus > 0 && i.avgMonthlyIncomeCents) {
    const planned = Math.max(STEP, roundDown(Math.min(Math.round(i.avgMonthlyIncomeCents * 0.1), Math.round(surplus * SURPLUS_SHARE))))
    out.push({
      key: 'habit', title: 'Save 10% of your income this year', kind: 'manual', targetCents: planned * 12,
      why: `Your debts are covered and your cushion is in place. Putting ${money(planned)} aside each month is ${money(planned * 12)} in a year, for whatever comes next: a trip, a car, a down payment. You add to it yourself as you save.`,
      plannedMonthlyCents: planned, deadline: monthEnd(addMonths(monthKey(i.today), 11)), monthsToFinish: 12, tone: 'comfortable', notes: `Suggested by the app. ${surplusNote}`
    })
  }
  return out
}
