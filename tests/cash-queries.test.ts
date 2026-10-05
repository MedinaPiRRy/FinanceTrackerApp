import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { addTip, addCashSpend, recordCashBill, depositCash, deleteCashEntry, cashBalanceCents } from '../src/db/cash'
import { queryTxns, setTxnCategory, getDashboard, listAccounts } from '../src/db/queries'

let db: Db
let p: number, p2: number, chq: number, expCat: number, incCat: number, phone: number
let n = 0
const txn = (profile: number, account: number, date: string, cents: number, desc: string, kind: string, category: number | null = null) =>
  Number(db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,'manual',?)`).run(profile, account, date, cents, desc, kind, category, `f${n++}`).lastInsertRowid)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('alex','Alex')").run().lastInsertRowid)
  p2 = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('sam','Sam')").run().lastInsertRowid)
  chq = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(p).lastInsertRowid)
  expCat = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Phone','expense')").run(p).lastInsertRowid)
  incCat = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Pay','income')").run(p).lastInsertRowid)
  phone = Number(db.prepare("INSERT INTO recurring (profile_id,name,direction,amount_cents,frequency) VALUES (?, 'Phone plan','expense',10000,'monthly')").run(p).lastInsertRowid)
})

describe('spending cash', () => {
  it('records cash spending as a real expense that lowers cash on hand and counts in the dashboard', () => {
    addTip(db, p, '2026-10-01', 30000)
    const r = addCashSpend(db, p, '2026-10-02', 11500, '  Lunch with friends ', expCat, 'with Sam')
    expect(r.balanceCents).toBe(18500)
    expect(cashBalanceCents(db, p)).toBe(18500)
    const row = db.prepare("SELECT description, amount_cents a, kind, notes, source FROM txn WHERE id = ?").get(r.id)
    expect(row).toEqual({ description: 'Lunch with friends', a: -11500, kind: 'expense', notes: 'with Sam', source: 'cash_entry' })
    expect(getDashboard(db, p, '2026-10')!.summary.expenseCents).toBe(11500)
  })
  it('validates the amount, the description, the category and the date', () => {
    expect(() => addCashSpend(db, p, '2026-10-02', 0, 'x', expCat)).toThrow(/greater than zero/)
    expect(() => addCashSpend(db, p, '2026-10-02', 100, '   ', expCat)).toThrow(/what the cash was spent on/)
    expect(() => addCashSpend(db, p, '2026-10-02', 100, 'x', incCat)).toThrow(/spending categories/)
    expect(() => addCashSpend(db, p2, '2026-10-02', 100, 'x', expCat)).toThrow(/spending categories/) // another person's category
    expect(() => addCashSpend(db, p, 'today', 100, 'x', expCat)).toThrow(/YYYY-MM-DD/)
  })
  it('can be removed like other cash entries, and may take cash below zero until tips are logged', () => {
    const r = addCashSpend(db, p, '2026-10-02', 5000, 'Parking', expCat)
    expect(cashBalanceCents(db, p)).toBe(-5000)
    expect(deleteCashEntry(db, p, r.id)).toBe(1)
    expect(cashBalanceCents(db, p)).toBe(0)
  })
})

describe('cash and tips', () => {
  it('tips become income in the Cash wallet, not in the bank', () => {
    addTip(db, p, '2026-10-01', 4500, 'Friday shift')
    addTip(db, p, '2026-10-02', 3000)
    expect(cashBalanceCents(db, p)).toBe(7500)
    const bank = listAccounts(db, p).find((a) => a.name === 'Chequing')!
    expect(bank.valueCents).toBe(0)
    expect(db.prepare("SELECT kind, source FROM txn WHERE description='Tips'").get()).toEqual({ kind: 'income', source: 'cash_entry' })
  })
  it('rejects zero/negative tips and bad dates', () => {
    expect(() => addTip(db, p, '2026-10-01', 0)).toThrow()
    expect(() => addTip(db, p, '2026-10-01', -5)).toThrow()
    expect(() => addTip(db, p, '10/01/2026', 100)).toThrow()
  })
  it('a cash-paid bill is a real expense, once per month', () => {
    addTip(db, p, '2026-10-01', 20000)
    recordCashBill(db, p, phone, '2026-10-05', expCat)
    expect(cashBalanceCents(db, p)).toBe(10000)
    expect(() => recordCashBill(db, p, phone, '2026-10-20', expCat)).toThrow(/already recorded/)
    recordCashBill(db, p, phone, '2026-11-05', expCat) // next month is fine
    const d = getDashboard(db, p, '2026-10')!
    expect(d.summary.expenseCents).toBe(10000)
  })
  it('depositing tips is a transfer: bank goes up, cash goes down, income is not doubled', () => {
    addTip(db, p, '2026-10-01', 20000)
    depositCash(db, p, '2026-10-03', 15000, chq)
    expect(cashBalanceCents(db, p)).toBe(5000)
    expect(listAccounts(db, p).find((a) => a.name === 'Chequing')!.valueCents).toBe(15000)
    expect(getDashboard(db, p, '2026-10')!.summary.incomeCents).toBe(20000)
  })
  it('refuses to deposit into another person\'s account', () => {
    const other = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(p2).lastInsertRowid)
    addTip(db, p, '2026-10-01', 20000)
    expect(() => depositCash(db, p, '2026-10-03', 1000, other)).toThrow()
  })
  it('deleting a deposit removes both legs; bank rows can never be deleted this way', () => {
    addTip(db, p, '2026-10-01', 20000)
    depositCash(db, p, '2026-10-03', 15000, chq)
    const leg = db.prepare("SELECT id FROM txn WHERE description = 'Cash deposited to bank'").get() as { id: number }
    expect(deleteCashEntry(db, p, leg.id)).toBe(2)
    expect(cashBalanceCents(db, p)).toBe(20000)
    const bankRow = txn(p, chq, '2026-10-01', -500, 'Coffee', 'expense', expCat)
    expect(() => deleteCashEntry(db, p, bankRow)).toThrow(/Only entries made on the Cash page/)
  })
})

describe('transaction queries', () => {
  beforeEach(() => {
    txn(p, chq, '2026-09-01', -1500, 'Tim Hortons', 'expense', expCat)
    txn(p, chq, '2026-09-02', -9000, 'Telus', 'expense', expCat)
    txn(p, chq, '2026-09-03', 200000, 'Paycheque', 'income', incCat)
    txn(p2, Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(p2).lastInsertRowid), '2026-09-02', -777, "Sam's coffee", 'expense')
  })
  it('never returns the other person\'s rows', () => {
    expect(queryTxns(db, p).total).toBe(3)
    expect(queryTxns(db, p2).total).toBe(1)
  })
  it('filters by text, kind, amount range and date', () => {
    expect(queryTxns(db, p, { text: 'tim' }).total).toBe(1)
    expect(queryTxns(db, p, { kind: 'income' }).total).toBe(1)
    expect(queryTxns(db, p, { minCents: 2000, maxCents: 10000 }).rows.map((r) => r.description)).toEqual(['Telus'])
    expect(queryTxns(db, p, { from: '2026-09-02', to: '2026-09-02' }).total).toBe(1)
  })
  it('sorts by amount (absolute) and by date', () => {
    expect(queryTxns(db, p, { sort: 'amount', dir: 'desc' }).rows[0]!.description).toBe('Paycheque')
    expect(queryTxns(db, p, { sort: 'date', dir: 'asc' }).rows[0]!.description).toBe('Tim Hortons')
  })
  it('recategorises only with a matching category from the same profile', () => {
    const id = (queryTxns(db, p, { text: 'Telus' }).rows[0]!).id
    const other = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Food','expense')").run(p).lastInsertRowid)
    setTxnCategory(db, id, other)
    expect(queryTxns(db, p, { text: 'Telus' }).rows[0]!.category).toBe('Food')
    expect(() => setTxnCategory(db, id, incCat)).toThrow(/expense category/)
    const foreign = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'X','expense')").run(p2).lastInsertRowid)
    expect(() => setTxnCategory(db, id, foreign)).toThrow(/someone else/)
  })
})

describe('dashboard', () => {
  it('is null with no data, and defaults to the latest month with data', () => {
    expect(getDashboard(db, p)).toBeNull()
    txn(p, chq, '2026-08-03', 100000, 'Pay', 'income', incCat)
    txn(p, chq, '2026-09-03', 100000, 'Pay', 'income', incCat)
    txn(p, chq, '2026-09-04', -25000, 'Stuff', 'expense', expCat)
    const d = getDashboard(db, p)!
    expect(d.month).toBe('2026-09')
    expect(d.summary).toMatchObject({ incomeCents: 100000, expenseCents: 25000, netCents: 75000 })
    expect(d.previous?.month).toBe('2026-08')
    expect(d.lastYear).toBeNull()
    expect(d.average?.months).toBe(1)
  })
})

describe('createCategory', () => {
  it('creates per profile, reuses same name case-insensitively, and validates', async () => {
    const { createCategory } = await import('../src/db/queries')
    const a = createCategory(db, p, '  Gifts ', 'income')
    expect(a.name).toBe('Gifts')
    expect(createCategory(db, p, 'gifts', 'income').id).toBe(a.id)
    expect(createCategory(db, p2, 'Gifts', 'income').id).not.toBe(a.id) // other person gets their own
    expect(() => createCategory(db, p, '   ', 'expense')).toThrow()
  })
})

describe('cash bills list', () => {
  it('only lists active bills tied to the Cash wallet, not cards whose name contains "cash"', async () => {
    const { listCashBills } = await import('../src/db/queries')
    const cashAcc = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Cash','cash')").run(p).lastInsertRowid)
    const card = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Rewards Visa','credit_card')").run(p).lastInsertRowid)
    const add = (name: string, acc: number, paidWith: string, status = 'active') =>
      db.prepare('INSERT INTO recurring (profile_id,name,direction,account_id,paid_with,amount_cents,frequency,status) VALUES (?,?,?,?,?,?,?,?)').run(p, name, 'expense', acc, paidWith, 1000, 'monthly', status)
    add('Spotify', card, 'Rewards Visa')
    add('Telus', cashAcc, 'Cash (tips)')
    add('Old cash bill', cashAcc, 'Cash', 'cancelled')
    expect(listCashBills(db, p).map((b) => b.name)).toEqual(['Telus'])
  })
})
