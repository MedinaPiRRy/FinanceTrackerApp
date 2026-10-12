// Taxes & interest: paid and received, marking single payments, leaving out payments, categories and accounts, and looking at the payments behind each figure.
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type Db } from '../src/db/open'
import { createCategory } from '../src/db/queries'
import { costsReport, costLines } from '../src/db/costsReport'
import { markCosts, setAccountCostsExcluded, setCostCategory } from '../src/db/costsManage'
import { setCategoryPurpose } from '../src/db/categoriesManage'
import { classifyCost, costKind } from '../src/core/costs'
import { createHandlers } from '../src/main/handlers'
import { dispatch } from '../src/main/dispatch'

let db: Db
let p: number, q: number, chq: number, card: number, chqQ: number
let taxes: number, propTax: number, credit: number, fees: number, food: number, pay: number
let n = 0
const add = (cents: number, desc: string, kind: string, cat: number | null, date = '2026-05-10', account = chq, profile = p) =>
  Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(profile, account, date, cents, desc, desc, kind, cat, `k${n++}`).lastInsertRowid)
const cat = (name: string, kind: 'expense' | 'income' = 'expense', parent: number | null = null) => createCategory(db, p, name, kind, parent).id
const rep = (year = 2026) => costsReport(db, [p], year)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
  q = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('babytas','Babytas')").run().lastInsertRowid)
  const acct = (pid: number, name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(pid, name, type).lastInsertRowid)
  chq = acct(p, 'Chequing', 'chequing'); card = acct(p, 'Visa', 'credit_card'); chqQ = acct(q, 'Chequing', 'chequing')
  taxes = cat('Taxes'); propTax = cat('Property tax', 'expense', taxes); credit = cat('GST/HST credit', 'income'); fees = cat('Bank Fees & Interest'); food = cat('Food'); pay = cat('Pay', 'income')
})

describe('what counts, and on which side', () => {
  const row = (o: Partial<Parameters<typeof classifyCost>[0]> = {}) => ({ kind: 'expense', amountCents: -1000, description: 'X', categoryPurpose: null, categoryName: null, ...o })

  it('money out is paid, money in is received, refunds reduce what was paid', () => {
    expect(classifyCost(row({ categoryName: 'Income tax' }))).toMatchObject({ kind: 'tax', side: 'paid', why: 'category' })
    expect(classifyCost(row({ kind: 'income', amountCents: 5000, categoryName: 'GST/HST credit' }))).toMatchObject({ kind: 'tax', side: 'received' })
    expect(classifyCost(row({ kind: 'refund', amountCents: 5000, categoryName: 'Income tax' }))).toMatchObject({ kind: 'tax', side: 'paid' })
    expect(costKind(row({ kind: 'income', amountCents: 5000, categoryName: 'GST/HST credit' }))).toBeNull() // costKind is the paid side only
  })

  it('a mark on the payment beats its category, and "not counted" beats everything', () => {
    expect(classifyCost(row({ categoryName: 'Groceries', markedPurpose: 'interest' }))).toMatchObject({ kind: 'interest', why: 'marked' })
    expect(classifyCost(row({ categoryName: 'Income tax', markedPurpose: 'none' }))).toBeNull()
    expect(classifyCost(row({ description: 'PURCHASE INTEREST', markedPurpose: 'none' }))).toBeNull()
    expect(classifyCost(row({ categoryName: 'Groceries', markedPurpose: 'tax', accountExcluded: true }))).toMatchObject({ kind: 'tax' }) // marked one by one: still counts
  })

  it('an excluded account is left out, a category setting beats the wording, and a transfer is never counted', () => {
    expect(classifyCost(row({ categoryName: 'Income tax', accountExcluded: true }))).toBeNull()
    expect(classifyCost(row({ description: 'PURCHASE INTEREST', categoryPurpose: 'none' }))).toBeNull()
    expect(classifyCost(row({ description: 'PURCHASE INTEREST' }))).toMatchObject({ kind: 'interest', why: 'wording' })
    expect(classifyCost(row({ kind: 'transfer', markedPurpose: 'tax' }))).toBeNull()
    expect(classifyCost(row({ kind: 'unclassified', amountCents: 1000, categoryName: 'Income tax' }))).toBeNull()
    expect(classifyCost(row({ kind: 'income', amountCents: 100, description: 'INTEREST EARNED' }))).toBeNull() // wording only ever judges what you paid
  })
})

describe('the report', () => {
  it('shows taxes paid, taxes received (a GST/HST credit) and the net, by month, category and account', () => {
    add(-120000, 'CRA PAYMENT', 'expense', taxes, '2026-04-30')
    add(-30000, 'CITY PROPERTY TAX', 'expense', propTax, '2026-06-30') // a subcategory counts under its main category
    add(30000, 'CRA REFUND', 'refund', taxes, '2026-05-15') // a refund reduces what was paid
    add(12500, 'GST CREDIT', 'income', credit, '2026-01-05'); add(12500, 'GST CREDIT', 'income', credit, '2026-04-05')
    add(-5000, 'LOBLAWS', 'expense', food, '2026-04-06')
    const r = rep()
    expect(r.tax.paidCents).toBe(120000 + 30000 - 30000)
    expect(r.tax.receivedCents).toBe(25000)
    expect(r.taxCents).toBe(120000)
    expect(r.months.find((m) => m.month === '2026-01')).toMatchObject({ taxReceivedCents: 12500, taxCents: 0 })
    expect(r.months.find((m) => m.month === '2026-04')).toMatchObject({ taxCents: 120000, taxReceivedCents: 12500 })
    expect(r.tax.byCategory.map((g) => [g.name, g.paidCents, g.receivedCents])).toEqual([['Taxes', 120000, 0], ['GST/HST credit', 0, 25000]])
    expect(r.tax.byAccount).toEqual([{ id: chq, name: 'Chequing', paidCents: 120000, receivedCents: 25000 }])
    expect(r.interest).toMatchObject({ paidCents: 0, receivedCents: 0 })
    expect(rep(2025).tax.paidCents).toBe(0)
    expect(r.years).toContain(2026)
  })

  it('lines that say interest count, fees in "Bank Fees & Interest" do not, and a fee given straight back cancels', () => {
    add(-4629, 'PURCHASE INTEREST', 'expense', fees, '2026-03-15', card); add(-500, 'OVERDRAFT FEE', 'expense', fees, '2026-03-16')
    add(-1495, 'MONTHLY FEE', 'expense', fees, '2026-03-01'); add(1495, 'MONTHLY FEE REBATE', 'refund', fees, '2026-03-01')
    add(-3000, 'INTEREST REVERSAL', 'refund', fees, '2026-03-20') // not money you paid
    expect(rep().interest.paidCents).toBe(4629)
    expect(rep().interest.byAccount.map((g) => g.name)).toEqual(['Visa'])
  })
})

describe('marking single payments', () => {
  it('counts any payment as taxes or interest, like choosing a category, and a mark can be taken off again', () => {
    const mortgage = add(-90000, 'MORTGAGE PAYMENT', 'expense', food, '2026-02-01')
    expect(rep().interest.paidCents).toBe(0)
    expect(markCosts(db, [mortgage], 'interest')).toEqual({ updated: 1 })
    expect(rep().interest.paidCents).toBe(90000)
    expect(costLines(db, [p], 2026, { kind: 'interest' }).rows[0]).toMatchObject({ id: mortgage, why: 'marked', marked: 'interest', side: 'paid', cents: 90000 })
    markCosts(db, [mortgage], 'tax')
    expect(rep().tax.paidCents).toBe(90000); expect(rep().interest.paidCents).toBe(0)
    markCosts(db, [mortgage], null)
    expect(rep().tax.paidCents).toBe(0)
  })

  it('money received can be marked too (a government payment that is part of your taxes)', () => {
    const gov = add(40000, 'GOV OF CANADA', 'income', pay, '2026-07-20')
    markCosts(db, [gov], 'tax')
    expect(rep().tax).toMatchObject({ paidCents: 0, receivedCents: 40000 })
    expect(costLines(db, [p], 2026, { kind: 'tax', side: 'received' }).rows.map((l) => l.id)).toEqual([gov])
  })

  it('refuses transfers, lines waiting in Review, missing payments, empty and silly requests', () => {
    const xfer = add(-5000, 'TO SAVINGS', 'transfer', null); const wait = add(-100, 'WHO', 'unclassified', null); const ok = add(-100, 'OK', 'expense', food)
    expect(() => markCosts(db, [xfer], 'tax')).toThrow(/transfer/)
    expect(() => markCosts(db, [wait, ok], 'tax')).toThrow(/waiting in Review/)
    expect(() => markCosts(db, [9999], 'tax')).toThrow(/no longer exist/)
    expect(() => markCosts(db, [], 'tax')).toThrow(/at least one/)
    expect(() => markCosts(db, [ok], 'nonsense' as never)).toThrow(/Choose Taxes/)
    expect(db.prepare('SELECT cost_purpose FROM txn WHERE id = ?').get(ok)).toEqual({ cost_purpose: null }) // nothing was half-applied
  })
})

describe('leaving things out', () => {
  it('removes one payment, lists it under "left out", and counts it again on request', () => {
    const a = add(-1000, 'CRA 1', 'expense', taxes, '2026-02-01'); add(-2000, 'CRA 2', 'expense', taxes, '2026-03-01')
    markCosts(db, [a], 'none')
    expect(rep().tax.paidCents).toBe(2000)
    expect(rep().removed.payments).toBe(1)
    expect(costLines(db, [p], 2026, { kind: 'removed' }).rows.map((l) => l.id)).toEqual([a])
    expect(costLines(db, [p], 2026, { kind: 'tax' }).total).toBe(1)
    markCosts(db, [a], null)
    expect(rep().tax.paidCents).toBe(3000); expect(rep().removed.payments).toBe(0)
  })

  it('removes a whole account, keeps payments you marked one by one, and puts the account back', () => {
    add(-4000, 'PURCHASE INTEREST', 'expense', fees, '2026-03-15', card)
    const chosen = add(-1000, 'CARD PROTECTION', 'expense', food, '2026-03-16', card); markCosts(db, [chosen], 'interest')
    add(-2500, 'LOAN INTEREST', 'expense', fees, '2026-03-17', chq)
    expect(rep().interest.paidCents).toBe(7500)
    setAccountCostsExcluded(db, card, true)
    expect(rep().interest.paidCents).toBe(1000 + 2500)
    expect(rep().removed.accounts).toEqual([{ id: card, name: 'Visa' }])
    setAccountCostsExcluded(db, card, false)
    expect(rep().interest.paidCents).toBe(7500)
    expect(() => setAccountCostsExcluded(db, 9999, true)).toThrow(/no longer exists/)
  })

  it('removes a whole category from the page, and a category can be Taxes even when it is income', () => {
    add(-1000, 'CRA', 'expense', taxes, '2026-02-01')
    setCostCategory(db, taxes, 'none')
    expect(rep().tax.paidCents).toBe(0)
    setCostCategory(db, taxes, null) // back to guessing from the name
    expect(rep().tax.paidCents).toBe(1000)
    const benefit = cat('Government benefits', 'income'); add(7000, 'CCB', 'income', benefit, '2026-02-02')
    expect(rep().tax.receivedCents).toBe(0)
    setCategoryPurpose(db, p, benefit, 'tax')
    expect(rep().tax.receivedCents).toBe(7000)
    expect(() => setCostCategory(db, 9999, 'tax')).toThrow(/no longer exists/)
  })
})

describe('looking at the payments behind a figure', () => {
  it('lists them newest first, 50 at a time, with totals for the whole list', () => {
    for (let i = 0; i < 60; i++) add(-100, `CRA ${i}`, 'expense', taxes, `2026-03-${String(1 + (i % 28)).padStart(2, '0')}`)
    const first = costLines(db, [p], 2026, { kind: 'tax', limit: 50 })
    expect(first).toMatchObject({ total: 60, paidCents: 6000, receivedCents: 0 })
    expect(first.rows).toHaveLength(50)
    expect(first.rows[0]!.date >= first.rows[49]!.date).toBe(true)
    expect(costLines(db, [p], 2026, { kind: 'tax', offset: 50, limit: 50 }).rows).toHaveLength(10)
  })

  it('filters by main category (including its subcategories), by account and by side', () => {
    add(-1000, 'CRA', 'expense', taxes, '2026-02-01'); add(-2000, 'CITY', 'expense', propTax, '2026-02-02', card); add(900, 'GST', 'income', credit, '2026-02-03')
    expect(costLines(db, [p], 2026, { kind: 'tax', categoryId: taxes }).rows.map((l) => l.description).sort()).toEqual(['CITY', 'CRA'])
    expect(costLines(db, [p], 2026, { kind: 'tax', categoryId: credit }).total).toBe(1)
    expect(costLines(db, [p], 2026, { kind: 'tax', accountId: card }).rows.map((l) => l.description)).toEqual(['CITY'])
    expect(costLines(db, [p], 2026, { kind: 'tax', side: 'received' }).paidCents).toBe(0)
    expect(costLines(db, [p], 2026, { kind: 'tax' }).rows.find((l) => l.description === 'CITY')!.category).toBe('Taxes › Property tax')
  })

  it('covers several people at once (the household view) and never mixes years', () => {
    const qTax = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Taxes','expense')").run(q).lastInsertRowid)
    add(-1000, 'CRA D', 'expense', taxes, '2026-02-01'); add(-5000, 'CRA B', 'expense', qTax, '2026-02-01', chqQ, q); add(-700, 'CRA OLD', 'expense', taxes, '2025-02-01')
    expect(costsReport(db, [p, q], 2026).tax.paidCents).toBe(6000)
    expect(costsReport(db, [p], 2026).tax.paidCents).toBe(1000)
    expect(costLines(db, [p, q], 2026, { kind: 'tax' }).total).toBe(2)
  })
})

describe('through the handlers', () => {
  it('works end to end for one person and for everyone, and refuses bad requests with plain messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cost-')); const file = path.join(dir, 'finance.db')
    const seed = openDb(file)
    const pid = Number(seed.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
    const a = Number(seed.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(pid).lastInsertRowid)
    const t = Number(seed.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Taxes','expense')").run(pid).lastInsertRowid)
    const tx = Number(seed.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,'2026-02-01',-1000,'CRA','CRA','expense',?,'import','h1')").run(pid, a, t).lastInsertRowid)
    seed.close()
    process.env.FINANCE_WORKBOOK_DIR = dir
    const h = createHandlers(file) as unknown as Record<string, unknown>
    const call = (m: string, ...args: unknown[]) => dispatch(h, m, args) as Promise<{ ok: boolean; data?: any; error?: string }>
    expect((await call('costsReport', pid, 2026)).data.tax.paidCents).toBe(1000)
    expect((await call('costsReport', null, 2026)).ok).toBe(true)
    expect((await call('costLines', pid, 2026, { kind: 'tax' })).data.rows[0].id).toBe(tx)
    expect((await call('costMark', [tx], 'none')).data).toEqual({ updated: 1 })
    expect((await call('costsReport', pid, 2026)).data.removed.payments).toBe(1)
    expect((await call('txns', pid, {})).data.rows[0].costPurpose).toBe('none')
    expect((await call('costAccountExclude', a, true)).ok).toBe(true)
    expect((await call('costCategorySet', t, 'interest')).ok).toBe(true)
    const bad = await call('costMark', [tx], 'banana')
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('Choose Taxes') })
    expect((await call('costLines', pid, 2026, 'nonsense')).ok).toBe(false)
    ;(h.close as () => void)()
  })
})

describe('the database', () => {
  it('has the new columns, with safe defaults and a checked value', () => {
    const cols = (t: string) => (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name)
    expect(cols('txn')).toContain('cost_purpose'); expect(cols('account')).toContain('costs_excluded')
    expect(db.prepare('SELECT costs_excluded FROM account WHERE id = ?').get(chq)).toEqual({ costs_excluded: 0 })
    const t = add(-100, 'x', 'expense', food)
    expect(() => db.prepare("UPDATE txn SET cost_purpose = 'banana' WHERE id = ?").run(t)).toThrow()
  })
})

describe('upgrading an existing database', () => {
  it('adds the columns without touching existing rows, makes a backup first, and nothing starts out marked or left out', async () => {
    const schema = (await import('../src/db/schema')) as Record<string, unknown>
    const cols = (schema.COST_MARKS ?? schema.V10_TABLES) as string
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-up2-')); const file = path.join(dir, 'finance.db')
    const raw = openDb(file)
    // turn it back into a database from before this change: drop the two columns and the version number
    raw.pragma('foreign_keys = OFF')
    raw.exec('ALTER TABLE txn DROP COLUMN cost_purpose; ALTER TABLE account DROP COLUMN costs_excluded;')
    raw.pragma(`user_version = ${(schema.SCHEMA_VERSION as number) - 1}`)
    const pr = Number(raw.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
    const ac = Number(raw.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(pr).lastInsertRowid)
    raw.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,'2026-01-01',-500,'OLD ROW','expense','import','up1')").run(pr, ac)
    raw.close()
    expect(cols).toContain('cost_purpose')
    const up = openDb(file)
    expect(up.pragma('user_version', { simple: true })).toBe(schema.SCHEMA_VERSION)
    expect(up.prepare('SELECT description, cost_purpose FROM txn').all()).toEqual([{ description: 'OLD ROW', cost_purpose: null }])
    expect(up.prepare('SELECT costs_excluded FROM account').all()).toEqual([{ costs_excluded: 0 }])
    expect(fs.readdirSync(dir).some((f) => f.includes('.bak-v'))).toBe(true)
    up.close()
  })
})
