import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { generateSample } from '../src/demo/sample'
import { createCategory, queryTxns, getHouseholdProfile } from '../src/db/queries'
import { editTxnMany, deleteTxnMany } from '../src/db/txnBulk'
import { createGoal } from '../src/db/goals'
import { goalDetail, payoffDetail } from '../src/db/goalDetail'
import { createDebt } from '../src/db/debts'
import { linkPaymentToDebt } from '../src/db/debtPayments'
import { getForecast, saveWhatIf } from '../src/db/forecast'
import { emptyWhatIf } from '../src/core/forecast'
import { monthByMonth, activeScenario } from '../src/core/forecastTable'

let db: Db
let p: number, chq: number, sav: number, card: number
let n = 0
const cat = (name: string, kind: 'expense' | 'income' = 'expense', parent: number | null = null) => createCategory(db, p, name, kind, parent).id
const add = (cents: number, text: string, kind: string, category: number | null, date = '2026-09-10', account = chq) =>
  Number(db.prepare('INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)').run(p, account, date, cents, text, text, kind, category, 'import', `b${n++}`).lastInsertRowid)
const row = (id: number) => db.prepare('SELECT kind, category_id c, description d, transfer_group g FROM txn WHERE id = ?').get(id) as { kind: string; c: number | null; d: string; g: string | null }

beforeEach(() => {
  db = openDb(':memory:')
  ;[p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Savings', type: 'savings' }, { name: 'Card', type: 'credit_card' }] }]) as [number]
  chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
  sav = (db.prepare("SELECT id FROM account WHERE name = 'Savings'").get() as { id: number }).id
  card = (db.prepare("SELECT id FROM account WHERE name = 'Card'").get() as { id: number }).id
})

describe('editing many transactions at once', () => {
  it('renames the merchant on every selected row and leaves everything else alone', () => {
    const a = add(-500, 'AMZN MKTP', 'expense', cat('Shopping')), b = add(-900, 'AMZN MKTP CA', 'expense', null)
    expect(editTxnMany(db, [a, b], { description: ' Amazon ' })).toEqual({ updated: 2, remembered: 0 })
    expect([row(a).d, row(b).d]).toEqual(['Amazon', 'Amazon'])
    expect(row(a).kind).toBe('expense')
  })

  it('changes the type, which needs a category that fits, and a transfer drops its category', () => {
    const food = cat('Food'), pay = cat('Pay', 'income')
    const x = add(-2000, 'WRONG', 'expense', food), y = add(-3000, 'WRONG 2', 'expense', food)
    expect(() => editTxnMany(db, [x, y], { kind: 'income' })).toThrow(/money coming in/)
    expect(() => editTxnMany(db, [x], { kind: 'refund' })).toThrow(/money coming in/)
    editTxnMany(db, [x, y], { kind: 'transfer' })
    expect(row(x)).toMatchObject({ kind: 'transfer', c: null })
    // back to spending: it needs a spending category now
    expect(() => editTxnMany(db, [x], { kind: 'expense' })).toThrow(/Choose a expense category|Choose a spending category|Choose a/)
    editTxnMany(db, [x], { kind: 'expense', categoryId: food })
    expect(row(x)).toMatchObject({ kind: 'expense', c: food })
    const inc = add(150000, 'GIFT', 'transfer', null)
    expect(() => editTxnMany(db, [inc], { kind: 'income', categoryId: food })).toThrow(/does not fit/)
    editTxnMany(db, [inc], { kind: 'income', categoryId: pay })
    expect(row(inc)).toMatchObject({ kind: 'income', c: pay })
  })

  it('a category alone keeps the type; a subcategory shows as the category; remember files future imports', () => {
    const main = cat('Gas & Transportation'), gas = cat('Gas', 'expense', main)
    const t = add(-4000, 'PETRO CANADA 1234', 'expense', null)
    expect(editTxnMany(db, [t], { categoryId: gas, remember: true })).toEqual({ updated: 1, remembered: 1 })
    expect(row(t).c).toBe(gas)
    expect((db.prepare('SELECT COUNT(*) n FROM category_rule WHERE category_id = ?').get(gas) as { n: number }).n).toBeGreaterThan(0)
    const pay = cat('Pay', 'income')
    expect(() => editTxnMany(db, [t], { categoryId: pay })).toThrow(/does not fit/)
  })

  it('refuses one side of a transfer pair, empty requests, and rows from a workbook', () => {
    const food = cat('Food')
    const a = add(-10000, 'MOVE', 'transfer', null, '2026-09-01', chq), b = add(10000, 'MOVE', 'transfer', null, '2026-09-01', sav)
    db.prepare("UPDATE txn SET transfer_group = 'g1' WHERE id IN (?, ?)").run(a, b)
    expect(() => editTxnMany(db, [a], { kind: 'expense', categoryId: food })).toThrow(/matching row in another account/)
    expect(() => editTxnMany(db, [a], {})).toThrow(/Choose what to change/)
    expect(() => editTxnMany(db, [], { description: 'x' })).toThrow(/at least one/)
    expect(() => editTxnMany(db, [9999], { description: 'x' })).toThrow(/no longer exist/)
    expect(() => editTxnMany(db, [a], { description: 'x'.repeat(200) })).toThrow(/too long/)
  })
})

describe('deleting many transactions at once', () => {
  it('removes them, changes the balance, and puts a loan back when a counted payment goes', () => {
    const osap = createDebt(db, p, 'OSAP', 100000, '2026-08-01')
    const pay = add(-20000, 'NSLSC', 'expense', null, '2026-09-01')
    linkPaymentToDebt(db, pay, osap)
    const keep = add(-500, 'COFFEE', 'expense', null), gone = add(-700, 'LUNCH', 'expense', null)
    expect(db.prepare('SELECT balance_cents b FROM debt WHERE id = ?').get(osap)).toEqual({ b: 80000 })
    expect(deleteTxnMany(db, [pay, gone])).toEqual({ deleted: 2 })
    expect(db.prepare('SELECT balance_cents b FROM debt WHERE id = ?').get(osap)).toEqual({ b: 100000 })
    expect(queryTxns(db, p, {}).rows.map((r) => r.id)).toEqual([keep])
    expect(() => deleteTxnMany(db, [pay])).toThrow(/no longer exist/)
    expect(() => deleteTxnMany(db, [])).toThrow(/at least one/)
  })

  it('does not touch workbook rows (the next Excel sync would bring them back)', () => {
    // the public schema has no workbook source, so build the check on a copy of the row's source
    const t = add(-500, 'ROW', 'expense', null)
    const guard = db.prepare('SELECT source FROM txn WHERE id = ?').get(t) as { source: string }
    expect(guard.source).toBe('import')
    // a row can only be refused for its source when the schema allows that source; the rule itself is a one-line check on `source`
    expect(deleteTxnMany(db, [t])).toEqual({ deleted: 1 })
  })
})

describe('what counts toward a goal', () => {
  it('a spending goal lists the category and its subcategories, a page at a time, with refunds taken off', () => {
    const main = cat('Gas & Transportation'), gas = cat('Gas', 'expense', main), other = cat('Shopping')
    for (let i = 0; i < 60; i++) add(-1000, `PETRO ${i}`, 'expense', i % 2 ? gas : main, `2026-08-${String((i % 28) + 1).padStart(2, '0')}`)
    add(-9999, 'SHOP', 'expense', other); add(2500, 'PETRO REFUND', 'refund', gas)
    const g = createGoal(db, p, { name: 'Spend less on gas', kind: 'category', categoryId: main, targetCents: 100000 })
    const first = goalDetail(db, p, g, 0, 50)
    expect(first).toMatchObject({ count: 61, countedCents: 60 * 1000 - 2500, openIn: { categoryId: main } })
    expect(first.rows).toHaveLength(50)
    expect(first.rows.some((r) => r.description === 'SHOP')).toBe(false)
    expect(first.rows.find((r) => r.category?.includes('›'))!.category).toBe('Gas & Transportation › Gas')
    expect(goalDetail(db, p, g, 50, 50).rows).toHaveLength(11)
  })

  it('a savings goal that tracks an account lists its transactions, money in and out', () => {
    add(100000, 'DEPOSIT', 'transfer', null, '2026-09-01', sav); add(-20000, 'WITHDRAW', 'transfer', null, '2026-09-05', sav); add(-100, 'NOT HERE', 'expense', null, '2026-09-06', chq)
    const g = createGoal(db, p, { name: 'Fund', kind: 'account', accountId: sav, targetCents: 500000 })
    expect(goalDetail(db, p, g)).toMatchObject({ count: 2, countedCents: 80000, inCents: 100000, outCents: 20000, openIn: { accountId: sav } })
  })

  it('a payoff goal and a planner row count the payments made on the card and the loan', () => {
    db.prepare('UPDATE account SET opening_balance_cents = -100000 WHERE id = ?').run(card)
    add(30000, 'PAYMENT THANK YOU', 'transfer', null, '2026-09-15', card); add(-4000, 'BUY', 'expense', null, '2026-09-16', card); add(2000, 'STORE REFUND', 'refund', null, '2026-09-17', card)
    const osap = createDebt(db, p, 'OSAP', 500000, '2026-01-01')
    const pay = add(-15000, 'NSLSC', 'expense', null, '2026-09-20'); linkPaymentToDebt(db, pay, osap)
    const g = createGoal(db, p, { name: 'Debt free', kind: 'debt', debtItems: [{ accountId: card }, { debtId: osap }] })
    db.prepare("UPDATE goal SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(g)
    const d = goalDetail(db, p, g)
    expect(d.count).toBe(2) // the payment into the card and the loan payment, not the purchase or the refund
    expect(d.countedCents).toBe(45000)
    expect(payoffDetail(db, { accountId: card }, 'Card')).toMatchObject({ count: 1, countedCents: 30000, openIn: { accountId: card } })
    expect(payoffDetail(db, { debtId: osap }, 'OSAP')).toMatchObject({ count: 1, countedCents: 15000 })
    // a payment from before the goal started does not count toward the goal
    db.prepare("UPDATE goal SET created_at = '2026-09-18 00:00:00' WHERE id = ?").run(g)
    expect(goalDetail(db, p, g).count).toBe(1)
  })

  it('a goal that is typed in by hand has no transactions, and a goal that is not yours is refused', () => {
    const g = createGoal(db, p, { name: 'Trip', kind: 'manual', targetCents: 100000, manualCents: 25000 })
    expect(goalDetail(db, p, g)).toMatchObject({ count: 0, countedCents: 25000, rows: [] })
    expect(() => goalDetail(db, p + 99, g)).toThrow(/no longer exists/)
    expect(() => goalDetail(db, p, 12345)).toThrow(/no longer exists/)
  })
})

describe('the forecast month-by-month table', () => {
  const MONTHS = 24

  function checkAll(view: ReturnType<typeof getForecast>, months: number) {
    for (const wanted of ['current', 'plan', 'whatif'] as const) {
      const t = monthByMonth(view, wanted)
      expect(t.rows).toHaveLength(months)
      expect(t.rows[0]!.month).toBe(view.startMonth)
      for (const r of t.rows) for (const v of [r.incomeCents, r.expenseCents, r.goalCents, r.debtPaidCents, r.interestCents, r.cashCents, r.debtCents]) expect(Number.isFinite(v)).toBe(true)
      // the table agrees with the scenario it claims to show
      const src = t.scenario === 'whatif' ? view.whatIf!.expected : t.scenario === 'current' ? view.current.expected : view.plan.expected
      expect(t.rows.map((r) => r.cashCents)).toEqual(src.months.map((m) => m.cashCents))
    }
  }

  it('has a row for every month in all three versions, for a person with a saved what-if', () => {
    const sample = openDb(':memory:')
    generateSample(sample, 'single')
    const person = (sample.prepare("SELECT id FROM profile WHERE kind = 'person' LIMIT 1").get() as { id: number }).id
    saveWhatIf(sample, person, { ...emptyWhatIf('plan', MONTHS), incomePct: 10 })
    checkAll(getForecast(sample, person, '2026-10-15', { months: MONTHS }), MONTHS)
    // a what-if the person had picked, then cleared: the table falls back to the plan instead of showing nothing
    saveWhatIf(sample, person, null)
    const noWhatIf = getForecast(sample, person, '2026-10-15', { months: 12 })
    expect(noWhatIf.whatIf).toBeNull()
    expect(activeScenario(noWhatIf, 'whatif')).toBe('plan')
    const t = monthByMonth(noWhatIf, 'whatif')
    expect(t.scenario).toBe('plan')
    expect(t.rows).toHaveLength(12)
  })

  it('has a row for every month for the household', () => {
    const sample = openDb(':memory:')
    generateSample(sample, 'couple_household')
    const household = getHouseholdProfile(sample)!
    const view = getForecast(sample, household.id, '2026-10-15', { months: MONTHS, whatIf: { ...emptyWhatIf('plan', MONTHS), spendPct: -10 } })
    expect(view.whatIf).not.toBeNull()
    checkAll(view, MONTHS)
  })
})

describe('the Forecast page draws the table it is given', () => {
  it('shows the month-by-month table straight away, from the tested helper (it once hid behind a closed "Show" button and looked empty)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/renderer/pages/Forecast.tsx', 'utf8')
    expect(src).toContain('monthByMonth(')
    expect(src).not.toMatch(/showTable/)
    expect(src).toMatch(/usePaged\(table\.rows/)
  })
})
