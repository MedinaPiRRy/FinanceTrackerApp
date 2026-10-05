import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type Db } from '../src/db/open'
import { createBudget, updateBudget, deleteBudget, listBudgets, budgetReport } from '../src/db/budgets'
import { createGoal, updateGoal, deleteGoal, listGoals } from '../src/db/goals'
import { createDebt, updateDebtBalance, debtHistory } from '../src/db/debts'
import { getMonthlyReview } from '../src/db/monthly'
import { getDashboard } from '../src/db/queries'
import { setValuation } from '../src/db/review'

let db: Db
let p: number, p2: number, chq: number, visa: number, inv: number
let dining: number, fuel: number, fun: number, pay: number, otherCat: number
let n = 0
const tx = (account: number, date: string, cents: number, desc: string, kind: string, cat: number | null, profile = p) =>
  db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,'manual',?)`).run(profile, account, date, cents, desc, kind, cat, `t${n++}`)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('alex','Alex')").run().lastInsertRowid)
  p2 = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('sam','Sam')").run().lastInsertRowid)
  const acct = (pid: number, name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(pid, name, type).lastInsertRowid)
  chq = acct(p, 'Chequing', 'chequing'); visa = acct(p, 'Visa', 'credit_card'); inv = acct(p, 'Home fund', 'investment')
  const cat = (pid: number, name: string, kind: string) => Number(db.prepare('INSERT INTO category (profile_id,name,kind) VALUES (?,?,?)').run(pid, name, kind).lastInsertRowid)
  dining = cat(p, 'Dining', 'expense'); fuel = cat(p, 'Fuel', 'expense'); fun = cat(p, 'Fun', 'expense'); pay = cat(p, 'Pay', 'income'); otherCat = cat(p2, 'Dining', 'expense')
  tx(chq, '2026-09-02', -20000, 'Restaurant', 'expense', dining)
  tx(chq, '2026-09-10', -5000, 'More food', 'expense', dining)
  tx(chq, '2026-09-11', 1500, 'Refund', 'refund', dining) // refunds reduce the spend
  tx(chq, '2026-09-12', -9000, 'Gas', 'expense', fuel)
  tx(chq, '2026-09-12', -50000, 'Card payment', 'transfer', null) // never counts
  tx(chq, '2026-09-01', 300000, 'Paycheque', 'income', pay)
  tx(chq, '2026-08-20', -99999, 'August food', 'expense', dining) // other month
})

describe('budgets', () => {
  it('reports spent/remaining per budget using expenses minus refunds, ignoring transfers and other months', () => {
    createBudget(db, p, 'Food', 25000, [dining])
    createBudget(db, p, 'Car', 20000, [fuel])
    const r = budgetReport(db, p, '2026-09', '2026-10-02')
    const food = r.lines.find((l) => l.name === 'Food')!
    expect(food).toMatchObject({ spentCents: 23500, remainingCents: 1500, state: 'near' }) // 200 + 50 - 15 = 235
    expect(r.lines.find((l) => l.name === 'Car')).toMatchObject({ spentCents: 9000, state: 'ok' })
    expect(r.totals).toEqual({ budgetCents: 45000, spentCents: 32500, remainingCents: 12500 })
    expect(r.inProgress).toBe(false)
  })
  it('lists spending that is in no budget', () => {
    createBudget(db, p, 'Food', 25000, [dining])
    const r = budgetReport(db, p, '2026-09', '2026-10-02')
    expect(r.unbudgeted).toEqual([{ categoryId: fuel, name: 'Fuel', spentCents: 9000 }])
  })
  it('a category can only be in one budget; income and foreign categories are refused', () => {
    createBudget(db, p, 'Food', 25000, [dining])
    expect(() => createBudget(db, p, 'Eating out', 1000, [dining])).toThrow(/already in the "Food" budget/)
    expect(() => createBudget(db, p, 'Pay', 1000, [pay])).toThrow(/income category/)
    expect(() => createBudget(db, p, 'X', 1000, [otherCat])).toThrow(/belongs to someone else/)
    expect(() => createBudget(db, p, 'food', 1000, [])).toThrow(/already a budget called/)
    expect(() => createBudget(db, p, 'Neg', -5, [])).toThrow(/negative/)
  })
  it('edit amount and categories; delete leaves transactions untouched', () => {
    const id = createBudget(db, p, 'Food', 25000, [dining])
    updateBudget(db, p, id, { monthlyCents: 30000, categoryIds: [dining, fun] })
    expect(listBudgets(db, p)[0]).toMatchObject({ monthlyCents: 30000, categoryIds: [dining, fun] })
    const before = (db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n
    deleteBudget(db, p, id)
    expect(listBudgets(db, p)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n).toBe(before)
    expect(() => deleteBudget(db, p2, id)).toThrow(/no longer exists/)
  })
  it('projects month-end spending only for the month in progress', () => {
    tx(chq, '2026-10-02', -1000, 'x', 'expense', dining)
    tx(chq, '2026-10-12', -12000, 'y', 'expense', dining)
    createBudget(db, p, 'Food', 25000, [dining])
    expect(budgetReport(db, p, '2026-10', '2026-10-05').lines[0]!.projectedCents).toBeNull() // fewer than 7 days
    expect(budgetReport(db, p, '2026-10', '2026-10-13').lines[0]!.projectedCents).toBe(Math.round((13000 / 13) * 31))
    expect(budgetReport(db, p, '2026-09', '2026-10-13').lines[0]!.projectedCents).toBeNull()
  })
})

describe('goals', () => {
  it('manual goal with a deadline computes required monthly and status', () => {
    const id = createGoal(db, p, { name: 'Trip', kind: 'manual', targetCents: 120000, manualCents: 30000, deadline: '2027-09-30', plannedMonthlyCents: 10000 })
    const g = listGoals(db, p, '2026-10-02').find((x) => x.id === id)!
    expect(g.progress).toMatchObject({ remainingCents: 90000, requiredMonthlyCents: 7500, status: 'on_track' })
  })
  it('account goal follows the investment value you enter', () => {
    createGoal(db, p, { name: 'Home', kind: 'account', targetCents: 6_000_000, accountId: inv, plannedMonthlyCents: 80000 })
    expect(listGoals(db, p, '2026-10-02')[0]!.progress.status).toBe('no_value')
    setValuation(db, inv, '2026-10-01', 1_500_000)
    expect(listGoals(db, p, '2026-10-02')[0]!.progress).toMatchObject({ achievedCents: 1_500_000, remainingCents: 4_500_000 })
  })
  it('category goal counts spending in that category plus anything saved by hand', () => {
    createGoal(db, p, { name: 'Dining fund', kind: 'category', targetCents: 1_000_000, categoryId: dining, manualCents: 10000 })
    expect(listGoals(db, p, '2026-10-02')[0]!.progress.achievedCents).toBe(10000 + 23500 + 99999)
  })
  it('debt goal starts at what is owed now and progresses as balances fall', () => {
    tx(visa, '2026-09-05', -100000, 'Big purchase', 'expense', dining) // owes $1,000 on the card
    const loan = createDebt(db, p, 'Dad', 450000, '2026-09-25', 'Family loan')
    const id = createGoal(db, p, { name: 'Clear debts', kind: 'debt', debtItems: [{ accountId: visa }, { debtId: loan }], plannedMonthlyCents: 25000 })
    let g = listGoals(db, p, '2026-10-02')[0]!
    expect(g.targetCents).toBe(550000)
    expect(g.progress.progress).toBe(0)
    tx(visa, '2026-09-20', 40000, 'Payment', 'transfer', null) // card payment: owes $600
    updateDebtBalance(db, p, loan, 400000, '2026-10-01') // loan down to $4,000
    g = listGoals(db, p, '2026-10-02')[0]!
    expect(g.progress.remainingCents).toBe(60000 + 400000)
    expect(g.progress.progress).toBeCloseTo(90000 / 550000)
    expect(g.items.map((i) => i.label)).toEqual(['Visa', 'Dad'])
    // re-selecting the items re-baselines (progress starts again from what is owed now)
    updateGoal(db, p, id, { name: 'Clear debts', kind: 'debt', debtItems: [{ accountId: visa }, { debtId: loan }] })
    expect(listGoals(db, p, '2026-10-02')[0]!.progress.progress).toBe(0)
  })
  it("refuses nonsense: nothing owed, other people's items, wrong kinds, no target", () => {
    expect(() => createGoal(db, p, { name: 'x', kind: 'debt', debtItems: [{ accountId: visa }] })).toThrow(/Nothing is owed/)
    expect(() => createGoal(db, p, { name: 'x', kind: 'debt', debtItems: [] })).toThrow(/at least one/)
    expect(() => createGoal(db, p, { name: 'x', kind: 'debt', debtItems: [{ accountId: chq }] })).toThrow(/not a credit card/)
    expect(() => createGoal(db, p2, { name: 'x', kind: 'account', targetCents: 100, accountId: inv })).toThrow(/your own accounts/)
    expect(() => createGoal(db, p, { name: 'x', kind: 'category', targetCents: 100, categoryId: pay })).toThrow(/spending categories/)
    expect(() => createGoal(db, p, { name: 'x', kind: 'manual', targetCents: 0 })).toThrow(/more than zero/)
    expect(() => createGoal(db, p, { name: '  ', kind: 'manual', targetCents: 5 })).toThrow(/name/)
    expect(() => createGoal(db, p, { name: 'x', kind: 'manual', targetCents: 5, deadline: 'soon' })).toThrow(/Deadline/)
  })
  it('edit and delete are limited to the owner; type cannot change', () => {
    const id = createGoal(db, p, { name: 'Trip', kind: 'manual', targetCents: 1000 })
    expect(() => updateGoal(db, p2, id, { name: 'Trip', kind: 'manual', targetCents: 1000 })).toThrow(/no longer exists/)
    expect(() => updateGoal(db, p, id, { name: 'Trip', kind: 'account', targetCents: 1000, accountId: inv })).toThrow(/cannot be changed/)
    updateGoal(db, p, id, { name: 'Big trip', kind: 'manual', targetCents: 2000, manualCents: 500 })
    expect(listGoals(db, p, '2026-10-02')[0]).toMatchObject({ name: 'Big trip', targetCents: 2000, manualCents: 500 })
    expect(() => deleteGoal(db, p2, id)).toThrow(/no longer exists/)
    deleteGoal(db, p, id)
    expect(listGoals(db, p, '2026-10-02')).toEqual([])
  })
})

describe('debt balances', () => {
  it('keeps a history; the latest dated balance is the current one even if entered out of order', () => {
    const d = createDebt(db, p, 'Tio', 270000, '2026-06-01')
    updateDebtBalance(db, p, d, 250000, '2026-08-01')
    updateDebtBalance(db, p, d, 260000, '2026-07-01') // an older reading entered late
    expect(db.prepare('SELECT balance_cents b, as_of a FROM debt WHERE id = ?').get(d)).toEqual({ b: 250000, a: '2026-08-01' })
    expect(debtHistory(db, p, d).map((h) => h.balanceCents)).toEqual([270000, 260000, 250000])
    expect(() => updateDebtBalance(db, p, d, -1, '2026-09-01')).toThrow(/negative/)
    expect(() => updateDebtBalance(db, p2, d, 1, '2026-09-01')).toThrow(/no longer exists/)
  })
})

describe('dashboard and monthly review', () => {
  it('shows budget left on the dashboard and budget/goal insights', () => {
    createBudget(db, p, 'Food', 25000, [dining])
    createGoal(db, p, { name: 'Trip', kind: 'manual', targetCents: 120000, deadline: '2027-09-30', plannedMonthlyCents: 10000 })
    const d = getDashboard(db, p, '2026-09', '2026-10-02')!
    expect(d.budget).toMatchObject({ budgetCents: 25000, spentCents: 23500, remainingCents: 1500, count: 1 })
    expect(d.insights.some((i) => i.title.includes('Food is at 94% of its budget'))).toBe(true)
    expect(d.insights.some((i) => i.title.includes('"Trip"'))).toBe(true)
  })
  it('review pulls it together: changes vs last month, top expenses, recurring check, pending items', () => {
    db.prepare('INSERT INTO recurring (profile_id,name,direction,account_id,amount_cents,frequency,status) VALUES (?,?,?,?,?,?,?)').run(p, 'Gas', 'expense', chq, 9000, 'monthly', 'active')
    db.prepare('INSERT INTO recurring (profile_id,name,direction,account_id,amount_cents,frequency,status) VALUES (?,?,?,?,?,?,?)').run(p, 'Gym', 'expense', chq, 1581, 'monthly', 'active')
    tx(chq, '2026-09-20', -3000, 'Mystery', 'expense', null)
    const r = getMonthlyReview(db, p, '2026-09', '2026-10-02')!
    expect(r.summary.incomeCents).toBe(300000)
    expect(r.topExpenses[0]).toMatchObject({ description: 'Restaurant', cents: 20000 })
    expect(r.categoryChanges.find((c) => c.name === 'Dining')).toMatchObject({ cents: 23500, prevCents: 99999, deltaCents: 23500 - 99999 })
    expect(r.recurring.find((x) => x.name === 'Gas')).toMatchObject({ status: 'paid', paidCents: 9000 })
    expect(r.recurring.find((x) => x.name === 'Gym')).toMatchObject({ status: 'not_seen' })
    expect(r.pending.uncategorizedCount).toBe(1)
  })
})
