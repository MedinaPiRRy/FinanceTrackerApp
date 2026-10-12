// Audit: functions that had no test of their own (found by the coverage scan), plus the checks that went with them.
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { pairTransfers } from '../src/db/transfers'
import { addSourceRule, findSourceRule, listSourceRules } from '../src/db/sourceRules'
import { applySourceRules, resolveReview } from '../src/db/review'
import { createAmountRule, updateAmountRule, loadAmountMatcher } from '../src/db/amountRules'
import { createCategory } from '../src/db/queries'
import { createBudget, spendByCategory } from '../src/db/budgets'
import { rememberLastAccount, suggestAccount, previousImportOf } from '../src/db/importMatch'
import { deleteProfileData, removePartner } from '../src/db/modeChange'
import { pairReversals, reversedIds } from '../src/core/offsets'

let db: Db
let p: number, q: number, chq: number, sav: number, card: number
let n = 0
const tx = (profile: number, account: number, date: string, cents: number, desc: string, kind: string, category: number | null = null, review: string | null = null) =>
  Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, review_reason, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,'import',?)").run(profile, account, date, cents, desc, desc, kind, category, review, `g${n++}`).lastInsertRowid)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
  q = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('babytas','Babytas')").run().lastInsertRowid)
  const acct = (pid: number, name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(pid, name, type).lastInsertRowid)
  chq = acct(p, 'Chequing', 'chequing'); sav = acct(p, 'Savings', 'savings'); card = acct(p, 'Visa', 'credit_card'); acct(q, 'Chequing', 'chequing')
})

describe('pairing the two halves of a transfer', () => {
  it('pairs equal and opposite amounts in different accounts within seven days, nearest first, once', () => {
    const a = tx(p, chq, '2026-03-01', -10000, 'To savings', 'transfer')
    const far = tx(p, sav, '2026-03-07', 10000, 'From chequing', 'transfer')
    const near = tx(p, sav, '2026-03-02', 10000, 'From chequing 2', 'transfer')
    expect(pairTransfers(db, p)).toBe(1)
    const g = (id: number) => (db.prepare('SELECT transfer_group g FROM txn WHERE id = ?').get(id) as { g: string | null }).g
    expect(g(a)).not.toBeNull()
    expect(g(a)).toBe(g(near))
    expect(g(far)).toBeNull()
    expect(pairTransfers(db, p)).toBe(0) // safe to repeat
  })
  it('does not pair within one account, across eight days, or with different amounts', () => {
    tx(p, chq, '2026-03-01', -10000, 'a', 'transfer'); tx(p, chq, '2026-03-01', 10000, 'b', 'transfer')
    tx(p, sav, '2026-03-12', 10000, 'c', 'transfer'); tx(p, sav, '2026-03-02', 9999, 'd', 'transfer')
    expect(pairTransfers(db, p)).toBe(0)
  })
  // AUDIT FINDING P-06 (low): the pairing compares every unlinked transfer with every other (n squared). 4,000 unlinked transfers is fine; 40,000 would not be.
  it('4,000 unlinked transfers (for example payments to an investment account that is never matched) pair or finish quickly', () => {
    const ins = db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,?,?,?,'transfer','import',?)")
    db.transaction(() => { for (let i = 0; i < 4000; i++) ins.run(p, chq, `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, -(1000 + i), 'to broker', `t${i}`) })()
    const t0 = Date.now()
    expect(pairTransfers(db, p)).toBe(0)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('"always do this" rules', () => {
  let food: number, pay: number
  beforeEach(() => { food = createCategory(db, p, 'Food', 'expense').id; pay = createCategory(db, p, 'Pay', 'income').id })

  it('are checked when saved: sign, category and name', () => {
    expect(() => addSourceRule(db, p, 'x', 'out', 'expense', food)).toThrow(/no name/)
    expect(() => addSourceRule(db, p, 'ACME', 'out', 'income', pay)).toThrow(/coming in/)
    expect(() => addSourceRule(db, p, 'ACME', 'in', 'expense', food)).toThrow(/going out/)
    expect(() => addSourceRule(db, p, 'ACME', 'out', 'expense', null)).toThrow(/category/)
  })
  it('apply to what is already waiting, only in their own direction, and leave a stale rule alone', () => {
    const waitOut = tx(p, chq, '2026-03-01', -2500, 'COFFEE HUT', 'unclassified', null, 'Needs your decision')
    const waitIn = tx(p, chq, '2026-03-02', 2500, 'COFFEE HUT', 'unclassified', null, 'Needs your decision')
    addSourceRule(db, p, 'COFFEE HUT', 'out', 'expense', food)
    expect(findSourceRule(db, p, 'COFFEE HUT', 'out')).toMatchObject({ kind: 'expense', categoryId: food })
    expect(findSourceRule(db, p, 'COFFEE HUT', 'in')).toBeNull()
    expect(applySourceRules(db, p)).toBe(1)
    const row = (id: number) => db.prepare('SELECT kind, review_reason r FROM txn WHERE id = ?').get(id) as { kind: string; r: string | null }
    expect(row(waitOut)).toEqual({ kind: 'expense', r: null })
    expect(row(waitIn).r).not.toBeNull() // the money-in line still waits
    // a rule whose category was deleted does not crash and does not file anything
    db.pragma('foreign_keys = OFF'); db.prepare('DELETE FROM category WHERE id = ?').run(food); db.pragma('foreign_keys = ON')
    const w2 = tx(p, chq, '2026-03-03', -1000, 'COFFEE HUT', 'unclassified', null, 'Needs your decision')
    expect(() => applySourceRules(db, p)).not.toThrow()
    expect(row(w2).r).not.toBeNull()
  })
  it('resolving with "remember" makes one rule that lists back with a readable name', () => {
    const t = tx(p, chq, '2026-03-01', -2500, 'COFFEE HUT #12', 'unclassified', null, 'Needs your decision')
    resolveReview(db, t, { kind: 'expense', categoryId: food }, { remember: true })
    expect(listSourceRules(db, p)).toHaveLength(1)
    expect(listSourceRules(db, p)[0]!.name).toBeTruthy()
  })
})

describe('amount rules', () => {
  it('can be edited and still match whole words only', () => {
    const snacks = createCategory(db, p, 'Snacks', 'expense').id, gas = createCategory(db, p, 'Gas', 'expense').id
    const id = createAmountRule(db, p, { name: 'Gas', words: ['PETRO'], limitCents: 3000, lowCategoryId: snacks, highCategoryId: gas })
    updateAmountRule(db, p, id, { name: 'Gas', words: ['SHELL'], limitCents: 5000, lowCategoryId: snacks, highCategoryId: gas })
    const m = loadAmountMatcher(db, p)
    expect(m('PETRO CANADA', -1000)).toBeNull()
    expect(m('SHELL 123', -4000)).toBe(snacks)
    expect(m('SHELL 123', -5001)).toBe(gas)
    expect(m('SHELLEY', -100)).toBeNull()
    expect(() => updateAmountRule(db, p, 9999, { name: 'x', words: ['ABC'], limitCents: 1, lowCategoryId: snacks, highCategoryId: gas })).toThrow(/no longer exists/)
  })
})

describe('budgets and subcategories', () => {
  it('a child with its own budget is counted there; otherwise it rolls up into its parent', () => {
    const main = createCategory(db, p, 'Transport', 'expense').id
    const gas = createCategory(db, p, 'Gas', 'expense', main).id
    tx(p, chq, '2026-03-05', -3000, 'PETRO', 'expense', gas); tx(p, chq, '2026-03-06', -1000, 'BUS', 'expense', main)
    expect(spendByCategory(db, p, '2026-03').get(main)).toBe(4000)
    createBudget(db, p, 'Gas only', 10000, [gas])
    const m = spendByCategory(db, p, '2026-03')
    expect(m.get(gas)).toBe(3000)
    expect(m.get(main)).toBe(1000)
  })
  it('a leap-day purchase belongs to February, and a month with no days of data gives an empty map', () => {
    const food = createCategory(db, p, 'Food', 'expense').id
    tx(p, chq, '2028-02-29', -500, 'LEAP', 'expense', food)
    expect(spendByCategory(db, p, '2028-02').get(food)).toBe(500)
    expect(spendByCategory(db, p, '2028-03').size).toBe(0)
  })
})

describe('which account does a file belong to', () => {
  it('remembers the last account, spots the same file, and asks instead of guessing when it is ambiguous', () => {
    expect(suggestAccount(db, p, null)).toBeNull()
    rememberLastAccount(db, p, card)
    expect(suggestAccount(db, p, null)).toMatchObject({ accountId: card, reason: 'last_used' })
    db.prepare("INSERT INTO import_batch (profile_id, account_id, source, filename, row_count, file_hash) VALUES (?,?,'import','a.csv',3,'abc')").run(p, chq)
    expect(previousImportOf(db, p, 'abc')).toMatchObject({ accountName: 'Chequing' })
    expect(previousImportOf(db, p, 'zzz')).toBeNull()
    expect(suggestAccount(db, p, { name: 'whatever.csv', layout: 'unknown', hash: 'abc' })).toMatchObject({ accountId: chq, reason: 'same_file' })
  })
})

describe('removing a person', () => {
  it('removes only that person\'s data and keeps the foreign keys sound', () => {
    const bq = (db.prepare('SELECT id FROM account WHERE profile_id = ?').get(q) as { id: number }).id
    tx(q, bq, '2026-03-01', -100, 'THEIRS', 'expense'); tx(p, chq, '2026-03-01', -200, 'MINE', 'expense')
    deleteProfileData(db, q)
    expect(db.prepare('SELECT COUNT(*) n FROM profile WHERE id = ?').get(q)).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM txn WHERE description = ?').get('MINE')).toEqual({ n: 1 })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1) // switched back on
  })
  it('an id that is really SQL is refused and no table is touched', () => {
    tx(p, chq, '2026-03-01', -200, 'MINE', 'expense')
    expect(() => deleteProfileData(db, '1; DROP TABLE txn; --' as unknown as number)).toThrow()
    expect(() => removePartner(db, '1 OR 1=1' as unknown as number, 'Babytas')).toThrow()
    expect(db.prepare('SELECT COUNT(*) n FROM txn').get()).toEqual({ n: 1 })
  })
})

describe('reversal pairs', () => {
  it('a charge and its exact refund cancel; a refund of a different amount does not; the same row is never used twice', () => {
    const rows = [
      { id: 1, accountId: 1, date: '2026-03-01', amountCents: -1495, kind: 'expense' as const, category: 'Fees', description: 'MONTHLY FEE' },
      { id: 2, accountId: 1, date: '2026-03-01', amountCents: 1495, kind: 'refund' as const, category: 'Fees', description: 'MONTHLY FEE REBATE' },
      { id: 3, accountId: 1, date: '2026-04-01', amountCents: -1495, kind: 'expense' as const, category: 'Fees', description: 'MONTHLY FEE' },
      { id: 4, accountId: 1, date: '2026-04-01', amountCents: 1000, kind: 'refund' as const, category: 'Fees', description: 'PARTIAL' }
    ]
    expect([...reversedIds(pairReversals(rows))].sort()).toEqual([1, 2])
  })
})

describe('goal start date and time zones', () => {
  // Was audit finding D-02: created_at is UTC and was compared with local dates. The test works in whatever time zone the machine is in:
  // it stores the creation time as UTC "now", and a payment dated today (local) must count, one dated yesterday (local) must not.
  it('a payment made on the day the goal was created counts toward it; one from the day before does not', async () => {
    const { createGoal } = await import('../src/db/goals')
    const { goalDetail } = await import('../src/db/goalDetail')
    db.prepare('UPDATE account SET opening_balance_cents = -100000 WHERE id = ?').run(card)
    const g = createGoal(db, p, { name: 'Pay off the card', kind: 'debt', debtItems: [{ accountId: card }] })
    const local = (d: Date) => d.toLocaleDateString('en-CA')
    const today = local(new Date()); const yesterday = local(new Date(Date.now() - 86_400_000))
    tx(p, card, today, 25000, 'PAYMENT THANK YOU', 'transfer')
    tx(p, card, yesterday, 10000, 'OLD PAYMENT', 'transfer')
    expect(goalDetail(db, p, g).count).toBe(1)
  })
})
