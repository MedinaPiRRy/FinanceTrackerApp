import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { createBudget } from '../src/db/budgets'
import { createGoal } from '../src/db/goals'
import { createDebt } from '../src/db/debts'
import { generateSample } from '../src/demo/sample'
import { getForecast, saveWhatIf, loadSavedWhatIf } from '../src/db/forecast'
import { getPlanner, savePlanner, resetPlanner } from '../src/db/debtPlan'
import { emptyWhatIf } from '../src/core/forecast'
import { getHouseholdProfile } from '../src/db/queries'

const TODAY = '2026-10-15'
let db: Db
let p: number, chq: number, card: number
let n = 0
const cat = (name: string, kind = 'expense') => (db.prepare('SELECT id FROM category WHERE profile_id = ? AND name = ? AND kind = ?').get(p, name, kind) as { id: number }).id
const tx = (account: number, date: string, cents: number, text: string, kind: string, category: number | null) =>
  db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(p, account, date, cents, text, text, kind, category, `f${n++}`)
const MONTHS = ['2026-07', '2026-08', '2026-09']

beforeEach(() => {
  db = openDb(':memory:')
  ;[p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Card', type: 'credit_card' }] }]) as [number]
  chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
  card = (db.prepare("SELECT id FROM account WHERE name = 'Card'").get() as { id: number }).id
  db.prepare('UPDATE account SET opening_balance_cents = 200000 WHERE id = ?').run(chq)
})

describe('forecast from data', () => {
  it('starts next month from today\'s balances and says so when there is no history', () => {
    const f = getForecast(db, p, TODAY)
    expect(f.startMonth).toBe('2026-11')
    expect(f.months).toBe(24)
    expect(f.current.expected.months[0]!.cashCents).toBe(200000) // nothing coming in or going out
    expect(f.notes.join(' ')).toMatch(/not enough history/)
  })

  it('regular pay (tracked) and irregular income (a range) come out as separate streams', () => {
    for (const m of MONTHS) tx(chq, `${m}-05`, 300000, 'ACME PAYROLL', 'income', cat('Pay', 'income'))
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, status, match_key) VALUES (?, 'Salary', 'income', ?, 300000, 'monthly', 'active', 'ACME PAYROLL')").run(p, chq)
    tx(chq, '2026-07-20', 20000, 'ETSY DEPOSIT', 'income', cat('Other income', 'income'))
    tx(chq, '2026-09-18', 100000, 'ETSY DEPOSIT', 'income', cat('Other income', 'income'))
    const f = getForecast(db, p, TODAY)
    const inc = f.inputs.plan.income
    expect(inc.find((s) => s.id.startsWith('inc:'))).toMatchObject({ label: 'Salary', kind: 'regular', monthlyCents: 300000 })
    expect(inc.some((s) => s.label === 'Pay')).toBe(false) // the paycheques are already the tracked item, not counted twice
    const side = inc.find((s) => s.label === 'Other income')!
    expect(side).toMatchObject({ kind: 'irregular', monthlyCents: 40000, lowCents: 0, highCents: 100000 })
    expect(f.plan.low.months[0]!.incomeCents).toBe(300000)
    expect(f.plan.expected.months[0]!.incomeCents).toBe(340000)
    expect(f.plan.high.months[0]!.incomeCents).toBe(400000)
  })

  it('a bill is taken out of its category so it is not counted twice', () => {
    for (const m of MONTHS) { tx(card, `${m}-09`, -1649, 'NETFLIX.COM', 'expense', cat('Subscriptions')); tx(card, `${m}-12`, -3000, 'GYM', 'expense', cat('Subscriptions')) }
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, status) VALUES (?, 'Netflix', 'expense', ?, 1649, 'monthly', 'active')").run(p, card)
    const f = getForecast(db, p, TODAY)
    expect(f.inputs.current.expenses.find((e) => e.id.startsWith('bill:'))).toMatchObject({ label: 'Netflix', monthlyCents: 1649 })
    expect(f.inputs.current.expenses.find((e) => e.id === 'cat:Subscriptions')!.monthlyCents).toBe(3000) // only the gym is left as everyday
    expect(f.current.expected.months[0]!.expenseCents).toBe(1649 + 3000)
  })

  it('the plan caps categories at their budget; "current" does not', () => {
    for (const m of MONTHS) tx(chq, `${m}-10`, -50000, 'RESTAURANTS', 'expense', cat('Dining'))
    createBudget(db, p, 'Eating out', 30000, [cat('Dining')])
    const f = getForecast(db, p, TODAY)
    expect(f.inputs.current.expenses.find((e) => e.id === 'cat:Dining')!.monthlyCents).toBe(50000)
    expect(f.inputs.plan.expenses.find((e) => e.id === 'cat:Dining')!.monthlyCents).toBe(30000)
    expect(f.plan.expected.months[0]!.expenseCents).toBe(30000)
  })

  it('the plan sets money aside for goals until they are reached; current does not', () => {
    for (const m of MONTHS) { tx(chq, `${m}-05`, 300000, 'PAY', 'income', cat('Pay', 'income')); tx(chq, `${m}-10`, -100000, 'STUFF', 'expense', cat('Shopping')) }
    createGoal(db, p, { name: 'Trip', kind: 'manual', targetCents: 100000, manualCents: 40000, plannedMonthlyCents: 20000 })
    const f = getForecast(db, p, TODAY)
    expect(f.current.expected.months[0]!.goalCents).toBe(0)
    expect(f.plan.expected.months.slice(0, 4).map((m) => m.goalCents)).toEqual([20000, 20000, 20000, 0])
    expect(f.plan.expected.goalDone).toEqual([{ id: expect.stringMatching(/^goal:/), label: 'Trip', month: '2027-01' }])
    expect(f.plan.expected.months[0]!.netWorthCents).toBe(f.current.expected.months[0]!.netWorthCents)
  })

  it('debts: current pays only minimums, the plan follows the planner, so the plan is debt-free sooner', () => {
    db.prepare('UPDATE account SET opening_balance_cents = -300000 WHERE id = ?').run(card)
    for (const m of MONTHS) { tx(chq, `${m}-05`, 400000, 'PAY', 'income', cat('Pay', 'income')); tx(chq, `${m}-10`, -150000, 'STUFF', 'expense', cat('Shopping')) }
    const f = getForecast(db, p, TODAY)
    expect(f.planner.debts[0]).toMatchObject({ key: `card:${card}`, balanceCents: 300000, aprBps: 1999, aprIsDefault: true })
    const cur = f.current.expected, plan = f.plan.expected
    expect(plan.totalInterestCents).toBeLessThan(cur.totalInterestCents)
    expect(plan.months.at(-1)!.debtCents).toBeLessThan(cur.months.at(-1)!.debtCents)
    expect(plan.debtFreeMonth).not.toBeNull()
  })

  it('a saved what-if is returned with the forecast and changes the result; invalid ones are refused', () => {
    for (const m of MONTHS) { tx(chq, `${m}-05`, 300000, 'PAY', 'income', cat('Pay', 'income')); tx(chq, `${m}-10`, -200000, 'STUFF', 'expense', cat('Shopping')) }
    const base = getForecast(db, p, TODAY)
    expect(base.whatIf).toBeNull()
    const w = { ...emptyWhatIf('plan', 24), incomePct: 10 }
    saveWhatIf(db, p, w)
    expect(loadSavedWhatIf(db, p)).toEqual(w)
    const f = getForecast(db, p, TODAY)
    expect(f.whatIf!.expected.months[0]!.incomeCents).toBe(330000)
    expect(getForecast(db, p, TODAY, { whatIf: null }).whatIf).toBeNull() // an explicit "none" ignores the saved one
    expect(() => saveWhatIf(db, p, { ...w, incomePct: 5000 })).toThrow(/out of range/)
    expect(() => saveWhatIf(db, p, { ...w, months: 0 })).toThrow(/out of range/)
    saveWhatIf(db, p, null)
    expect(loadSavedWhatIf(db, p)).toBeNull()
  })

  it('horizon is clamped to something sensible', () => {
    expect(getForecast(db, p, TODAY, { months: 500 }).months).toBe(120)
    expect(getForecast(db, p, TODAY, { months: 0 }).months).toBe(1)
  })
})

describe('debt planner (database)', () => {
  beforeEach(() => {
    db.prepare('UPDATE account SET opening_balance_cents = -200000 WHERE id = ?').run(card)
    createDebt(db, p, 'Family loan', 120000, '2026-09-01')
  })

  it('lists cards and loans with defaults, then remembers what the person enters', () => {
    const s = getPlanner(db, p, TODAY)
    expect(s.debts.map((d) => [d.label, d.balanceCents, d.aprBps, d.aprIsDefault])).toEqual([['Card', 200000, 1999, true], ['Family loan', 120000, 0, true]])
    expect(s.strategy).toBe('avalanche')
    expect(s.budgetIsDefault).toBe(true)
    const loanKey = s.debts[1]!.key
    const saved = savePlanner(db, p, { terms: [{ key: `card:${card}`, aprBps: 2499, minPaymentCents: 6000 }, { key: loanKey, aprBps: 500 }], strategy: 'snowball', monthlyBudgetCents: 40000 }, TODAY)
    expect(saved.debts[0]).toMatchObject({ aprBps: 2499, aprIsDefault: false, minPaymentCents: 6000, minIsDefault: false })
    expect(saved.debts[1]).toMatchObject({ aprBps: 500, aprIsDefault: false, minIsDefault: true })
    expect(saved).toMatchObject({ strategy: 'snowball', monthlyBudgetCents: 40000, budgetIsDefault: false })
    expect(saved.results.chosen.strategy).toBe('snowball')
    expect(resetPlanner(db, p, TODAY)).toMatchObject({ strategy: 'avalanche', budgetIsDefault: true })
    expect(getPlanner(db, p, TODAY).debts[0]!.aprBps).toBe(2499) // rates stay: only the plan choices reset
  })

  it('unsaved edits preview without changing anything', () => {
    const live = getPlanner(db, p, TODAY, { strategy: 'minimum', terms: [{ key: `card:${card}`, aprBps: 3000 }] })
    expect(live.results.chosen.strategy).toBe('minimum')
    expect(live.debts[0]!.aprBps).toBe(3000)
    expect(getPlanner(db, p, TODAY).debts[0]!.aprBps).toBe(1999)
  })

  it('compares the three strategies, and avalanche never costs more than snowball', () => {
    const r = getPlanner(db, p, TODAY, { monthlyBudgetCents: 30000 }).results
    expect(r.avalanche.totalInterestCents).toBeLessThanOrEqual(r.snowball.totalInterestCents)
    expect(r.minimum.months!).toBeGreaterThan(r.avalanche.months!)
  })

  it('a debt goal\'s planned monthly amount raises the default budget', () => {
    createGoal(db, p, { name: 'Clear card', kind: 'debt', debtItems: [{ accountId: card }], plannedMonthlyCents: 60000 })
    expect(getPlanner(db, p, TODAY).monthlyBudgetCents).toBeGreaterThanOrEqual(60000)
  })

  it('refuses bad numbers and unknown debts, and saves nothing when it refuses', () => {
    expect(() => savePlanner(db, p, { terms: [{ key: 'card:9999', aprBps: 100 }] }, TODAY)).toThrow(/not part of this plan/)
    expect(() => savePlanner(db, p, { terms: [{ key: `card:${card}`, aprBps: 20000 }] }, TODAY)).toThrow(/between 0% and 100%/)
    expect(() => savePlanner(db, p, { terms: [{ key: `card:${card}`, minPaymentCents: -1 }] }, TODAY)).toThrow(/cannot be negative/)
    expect(() => savePlanner(db, p, { strategy: 'yolo' as never }, TODAY)).toThrow(/payoff orders/)
    expect(() => savePlanner(db, p, { monthlyBudgetCents: -5 }, TODAY)).toThrow(/cannot be negative/)
    expect(getPlanner(db, p, TODAY).debts[0]!.aprIsDefault).toBe(true)
  })
})

describe('sample data and the household', () => {
  const NOW = new Date(2026, 9, 25)
  it('every sample setup produces a sensible forecast', () => {
    for (const mode of ['single', 'couple', 'couple_household'] as const) {
      const d = openDb(':memory:')
      generateSample(d, mode, NOW)
      const pid = (d.prepare("SELECT id FROM profile WHERE kind = 'person' ORDER BY id").get() as { id: number }).id
      const f = getForecast(d, pid, '2026-10-25')
      expect(f.months).toBe(24)
      expect(f.inputs.plan.income.length).toBeGreaterThan(0)
      expect(f.plan.expected.months).toHaveLength(24)
      expect(f.plan.low.months[23]!.cashCents).toBeLessThanOrEqual(f.plan.expected.months[23]!.cashCents)
      expect(f.plan.expected.months[23]!.cashCents).toBeLessThanOrEqual(f.plan.high.months[23]!.cashCents)
      expect(f.basedOnMonths.length).toBeGreaterThanOrEqual(3)
    }
  })
  it('the household forecast combines everyone (and the planner lists whose each debt is)', () => {
    const d = openDb(':memory:')
    generateSample(d, 'couple_household', NOW)
    const h = getHouseholdProfile(d).id
    const first = (d.prepare("SELECT id FROM profile WHERE kind = 'person' ORDER BY id").get() as { id: number }).id
    const one = getForecast(d, first, '2026-10-25')
    const all = getForecast(d, h, '2026-10-25')
    expect(all.inputs.plan.startCashCents).toBeGreaterThan(one.inputs.plan.startCashCents)
    expect(all.planner.debts.every((x) => x.owner !== null)).toBe(true)
    expect(all.inputs.plan.income.length).toBeGreaterThanOrEqual(one.inputs.plan.income.length)
  })
})
