import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createCategory, listCategories, queryTxns, getDashboard } from '../src/db/queries'
import { listCategoryManage, setCategoryParent, setCategoryPurpose, deleteCategory, renameCategory } from '../src/db/categoriesManage'
import { createBudget, budgetReport } from '../src/db/budgets'
import { budgetDrill } from '../src/db/budgetDrill'
import { createAmountRule, listAmountRules, applyAmountRule, amountCategory, deleteAmountRule } from '../src/db/amountRules'
import { buildPreview } from '../src/db/import'
import { createDebt } from '../src/db/debts'
import { linkPaymentToDebt } from '../src/db/debtPayments'
import { debtDetail } from '../src/db/debtDetail'
import { costsReport } from '../src/db/costsReport'
import { guessPurpose, costKind } from '../src/core/costs'
import { createAsset, updateAssetValue, updateAsset, deleteAsset, assetHistory, listAssets, netWorth } from '../src/db/assets'
import { checkBalance } from '../src/db/accountChecks'

let db: Db
let p: number, chq: number, card: number
let n = 0
const cat = (name: string, kind: 'expense' | 'income' = 'expense', parent: number | null = null) => createCategory(db, p, name, kind, parent).id
const add = (cents: number, text: string, kind: string, category: number | null, date = '2026-09-10', account = chq, source = 'import') =>
  Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)").run(p, account, date, cents, text, text, kind, category, source, `c${n++}`).lastInsertRowid)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('sam', 'Sam')").run().lastInsertRowid)
  chq = Number(db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Chequing', 'chequing')").run(p).lastInsertRowid)
  card = Number(db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Visa', 'credit_card')").run(p).lastInsertRowid)
})

describe('subcategories', () => {
  it('sit under one main category of the same kind, show as "Main › Sub", and list right under their parent', () => {
    const gas = cat('Gas & Transportation')
    const sub = createCategory(db, p, 'Gas', 'expense', gas)
    expect(sub).toMatchObject({ name: 'Gas', parentId: gas, parentName: 'Gas & Transportation', label: 'Gas & Transportation › Gas' })
    cat('Bills'); cat('Parking', 'expense', gas)
    expect(listCategories(db, p).filter((c) => c.kind === 'expense').map((c) => c.label)).toEqual(['Bills', 'Gas & Transportation', 'Gas & Transportation › Gas', 'Gas & Transportation › Parking'])
    expect(() => createCategory(db, p, 'Premium', 'expense', sub.id)).toThrow(/cannot have subcategories/)
    expect(() => createCategory(db, p, 'Side job', 'income', gas)).toThrow(/same|has to sit under/)
    expect(() => createCategory(db, p, 'Gas', 'expense', null)).toThrow(/already a category called "Gas" \(a subcategory\)/)
    expect(createCategory(db, p, 'gas', 'expense', gas).id).toBe(sub.id) // asking again returns the same one
  })

  it('a main category filter includes its subcategories, and a transaction shows its full label', () => {
    const gas = cat('Gas & Transportation'), sub = cat('Gas', 'expense', gas), other = cat('Shopping')
    add(-4000, 'PETRO', 'expense', sub); add(-1500, 'BUS', 'expense', gas); add(-900, 'SHOP', 'expense', other)
    const r = queryTxns(db, p, { categoryId: gas })
    expect(r.rows.map((x) => x.category).sort()).toEqual(['Gas & Transportation', 'Gas & Transportation › Gas'])
    expect(queryTxns(db, p, { categoryId: sub }).total).toBe(1)
  })

  it('totals, the dashboard and budgets count a subcategory in its main category, with the split kept', () => {
    const gas = cat('Gas & Transportation'), sub = cat('Gas', 'expense', gas), park = cat('Parking', 'expense', gas)
    add(-4000, 'PETRO', 'expense', sub); add(-1500, 'BUS', 'expense', gas); add(-500, 'LOT', 'expense', park); add(300000, 'PAY', 'income', cat('Pay', 'income'))
    const d = getDashboard(db, p, '2026-09', '2026-10-09')!
    expect(d.summary.byCategory['Gas & Transportation']).toBe(6000)
    expect(Object.keys(d.summary.byCategory)).not.toContain('Gas')
    expect(d.subSpend['Gas & Transportation']).toEqual([{ name: 'Gas', cents: 4000 }, { name: 'Other', cents: 1500 }, { name: 'Parking', cents: 500 }])
    const b = createBudget(db, p, 'Getting around', 20000, [gas])
    expect(budgetReport(db, p, '2026-09', '2026-10-09').lines.find((l) => l.id === b)!.spentCents).toBe(6000)
    expect(budgetDrill(db, p, b, '2026-09').totalCents).toBe(6000)
    // a subcategory with a budget of its own is counted there instead
    const own = createBudget(db, p, 'Gas only', 10000, [sub])
    const rep = budgetReport(db, p, '2026-09', '2026-10-09')
    expect(rep.lines.find((l) => l.id === own)!.spentCents).toBe(4000)
    expect(rep.lines.find((l) => l.id === b)!.spentCents).toBe(2000)
  })

  it('an existing category can be moved under another (or made a main category again), within the rules', () => {
    const gas = cat('Gas & Transportation'), sub = cat('Gas'), pay = cat('Pay', 'income')
    setCategoryParent(db, p, sub, gas)
    expect(listCategories(db, p).find((c) => c.id === sub)!.label).toBe('Gas & Transportation › Gas')
    expect(() => setCategoryParent(db, p, gas, sub)).toThrow(/cannot have subcategories/)
    expect(() => setCategoryParent(db, p, gas, gas)).toThrow(/under itself/)
    expect(() => setCategoryParent(db, p, pay, gas)).toThrow(/same kind/)
    expect(() => setCategoryParent(db, p, cat('Fuel'), sub)).toThrow(/cannot have subcategories|Pick a main category/)
    expect(() => setCategoryParent(db, p, gas, cat('Other main'))).toThrow(/has subcategories of its own/)
    setCategoryParent(db, p, sub, null)
    expect(listCategories(db, p).find((c) => c.id === sub)!.parentId).toBeNull()
  })

  it('a main category with subcategories cannot be deleted until they are gone; renames must stay unique', () => {
    const gas = cat('Gas & Transportation'), sub = cat('Gas', 'expense', gas)
    expect(() => deleteCategory(db, p, gas, null)).toThrow(/has 1 subcategory/)
    deleteCategory(db, p, sub, null)
    deleteCategory(db, p, gas, null)
    expect(() => renameCategory(db, p, cat('A'), 'a')).not.toThrow() // same name, only the case differs, is the same category
    const row = listCategoryManage(db, p).find((c) => c.name === 'a')!
    expect(row.parentId).toBeNull()
  })
})

describe('rules that depend on the amount', () => {
  let main: number, gas: number, snacks: number
  beforeEach(() => { main = cat('Gas & Transportation'); gas = cat('Gas', 'expense', main); snacks = cat('Snacks & Drinks') })
  const rule = () => createAmountRule(db, p, { name: 'Gas stations', words: ['petro', 'shell', 'mobil', 'circle k'], limitCents: 3000, lowCategoryId: snacks, highCategoryId: gas })

  it('picks the category by amount, matches whole words only, and only for money going out', () => {
    rule()
    const rules = listAmountRules(db, p)
    expect(rules[0]).toMatchObject({ words: ['PETRO', 'SHELL', 'MOBIL', 'CIRCLE K'], lowCategory: 'Snacks & Drinks', highCategory: 'Gas & Transportation › Gas' })
    const pick = (key: string, cents: number) => amountCategory(rules, key, cents)
    expect(pick('PETRO-CANADA', -1250)).toBe(snacks)
    expect(pick('PETRO-CANADA', -3000)).toBe(snacks) // up to and including $30
    expect(pick('PETRO-CANADA', -3001)).toBe(gas)
    expect(pick('CIRCLE K', -8000)).toBe(gas)
    expect(pick('ROGERS MOBILE', -8000)).toBeNull() // MOBIL is not a word in MOBILE
    expect(pick('PETRO-CANADA', 2000)).toBeNull() // a refund
    expect(pick('LOBLAWS', -2000)).toBeNull()
  })

  it('is checked before the rule is saved', () => {
    const base = { name: 'x', words: ['PETRO'], limitCents: 3000, lowCategoryId: snacks, highCategoryId: gas }
    expect(() => createAmountRule(db, p, { ...base, words: ['  '] })).toThrow(/at least one word/)
    expect(() => createAmountRule(db, p, { ...base, words: ['GO'] })).toThrow(/3 letters/)
    expect(() => createAmountRule(db, p, { ...base, limitCents: 0 })).toThrow(/more than zero/)
    expect(() => createAmountRule(db, p, { ...base, highCategoryId: snacks })).toThrow(/two different categories/)
    expect(() => createAmountRule(db, p, { ...base, highCategoryId: cat('Pay', 'income') })).toThrow(/spending categories/)
  })

  it('files an import by amount, ahead of any guess', () => {
    rule()
    const pv = buildPreview(db, p, chq, { format: 'headered', warnings: [], rows: [
      { line: 2, date: '2026-10-01', description: 'POINT OF SALE - INTERAC RETAIL PURCHASE 1234 PETRO-CANADA MILTON ON', amountCents: -1850 },
      { line: 3, date: '2026-10-02', description: 'POINT OF SALE - INTERAC RETAIL PURCHASE 1234 PETRO-CANADA MILTON ON', amountCents: -7420 }
    ] }, 'oct.csv')
    expect(pv.rows.map((r) => [r.categoryId, r.reviewReason])).toEqual([[snacks, null], [gas, null]])
  })

  it('applies to purchases still waiting for a category, never to hand-typed rows or ones already filed unless asked', () => {
    const id = rule()
    const waiting = add(-1500, 'PETRO-CANADA', 'expense', null)
    const needs = Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, review_reason, source, fingerprint) VALUES (?,?,'2026-09-11',-6000,'SHELL','SHELL','expense','Needs a category','import','w1')").run(p, chq).lastInsertRowid)
    const filed = add(-1500, 'PETRO-CANADA', 'expense', main) // the built-in guess put it in Gas & Transportation
    const typed = add(-1500, 'Petro-Canada', 'expense', null, '2026-09-12', chq, 'manual')
    expect(applyAmountRule(db, p, id, { dryRun: true })).toEqual({ matched: 2, changed: 2 })
    expect(applyAmountRule(db, p, id)).toEqual({ matched: 2, changed: 2 })
    const cats = (ids: number[]) => ids.map((i) => (db.prepare('SELECT category_id c FROM txn WHERE id = ?').get(i) as { c: number | null }).c)
    expect(cats([waiting, needs, filed, typed])).toEqual([snacks, gas, main, null])
    expect((db.prepare('SELECT review_reason r FROM txn WHERE id = ?').get(needs) as { r: string | null }).r).toBeNull()
    expect(applyAmountRule(db, p, id, { includeCategorised: true })).toEqual({ matched: 3, changed: 1 }) // now also the guessed one
    expect(cats([filed, typed])).toEqual([snacks, null])
    deleteAmountRule(db, p, id)
    expect(listAmountRules(db, p)).toEqual([])
  })

  it('deleting a category a rule uses needs somewhere to move it', () => {
    const id = rule()
    expect(() => deleteCategory(db, p, snacks, null)).toThrow(/Pick the category to move/)
    deleteCategory(db, p, snacks, cat('Treats'))
    expect(listAmountRules(db, p).find((r) => r.id === id)!.lowCategory).toBe('Treats')
  })
})

describe('taxes and interest', () => {
  it('guesses from names, honours what the person set, and reads interest out of the words', () => {
    expect(['Income Tax', 'Property taxes', 'HST', 'Bank Fees & Interest', 'Groceries', 'Taxi'].map(guessPurpose)).toEqual(['tax', 'tax', 'tax', 'interest', 'none', 'none'])
    const base = { amountCents: -500, description: 'x', categoryPurpose: null, categoryName: 'Bank Fees' }
    expect(costKind({ ...base, kind: 'expense', description: 'PURCHASE INTEREST' })).toBe('interest')
    expect(costKind({ ...base, kind: 'expense', description: 'INTEREST REVERSAL' })).toBeNull()
    expect(costKind({ ...base, kind: 'expense', description: 'PURCHASE INTEREST', categoryPurpose: 'none' })).toBeNull()
    expect(costKind({ ...base, kind: 'income', description: 'INTEREST' })).toBeNull()
    expect(costKind({ ...base, kind: 'expense', categoryName: 'Property Tax' })).toBe('tax')
  })

  it('adds up a year by month, nets refunds and bank reversals, and keeps the lines', () => {
    const tax = cat('Taxes'), fees = cat('Bank Fees'), food = cat('Groceries')
    add(-120000, 'CRA PAYMENT', 'expense', tax, '2026-04-30'); add(30000, 'CRA REFUND', 'refund', tax, '2026-05-15')
    add(-3657, 'PURCHASE INTEREST', 'expense', fees, '2026-01-15', card); add(-3657, 'PURCHASE INTEREST', 'expense', fees, '2026-02-15', card)
    add(-1495, 'MONTHLY FEE', 'expense', fees, '2026-03-01'); add(1495, 'MONTHLY FEE REBATE', 'refund', fees, '2026-03-01') // a fee given straight back: not interest, not tax
    add(-5000, 'LOBLAWS', 'expense', food, '2026-03-02'); add(-9999, 'PURCHASE INTEREST', 'expense', fees, '2025-12-15', card) // other year
    setCategoryPurpose(db, p, fees, 'none')
    let r = costsReport(db, [p], 2026)
    expect(r.interestCents).toBe(0) // the person said Bank Fees is neither
    expect(r.taxCents).toBe(90000)
    expect(r.taxBy).toEqual([{ name: 'Taxes', cents: 90000 }])
    expect(r.months.find((m) => m.month === '2026-04')!.taxCents).toBe(120000)
    expect(r.months.find((m) => m.month === '2026-05')!.taxCents).toBe(-30000)
    setCategoryPurpose(db, p, fees, null) // back to guessing: the name says Fees, the words say interest
    r = costsReport(db, [p], 2026)
    expect(r.interestCents).toBe(3657 * 2)
    expect(r.interestLines.map((l) => l.date)).toEqual(['2026-02-15', '2026-01-15'])
    expect(r.interestBy).toEqual([{ name: 'Visa', cents: 7314 }])
    expect(r.years).toEqual([2026, 2025])
    expect(costsReport(db, [p], 2025).interestCents).toBe(9999)
  })
})

describe('what you own and net worth', () => {
  it('keeps a value history like a loan, and net worth adds accounts and things owned and takes off what is owed', () => {
    db.prepare("UPDATE account SET opening_balance_cents = 100000 WHERE id = ?").run(chq)
    db.prepare("UPDATE account SET opening_balance_cents = -50000 WHERE id = ?").run(card)
    createDebt(db, p, 'OSAP', 1_000_000, '2026-09-01')
    const house = createAsset(db, p, { name: 'House', kind: 'property', valueCents: 50_000_000, asOf: '2026-01-01' })
    createAsset(db, p, { name: 'Car', kind: 'vehicle', valueCents: 1_500_000, asOf: '2026-01-01' })
    expect(netWorth(db, [p])).toEqual({ accountsCents: 100000, cardsOwedCents: 50000, debtsCents: 1_000_000, assetsCents: 51_500_000, netWorthCents: 100000 + 51_500_000 - 50000 - 1_000_000 })
    updateAssetValue(db, p, house, 52_000_000, '2026-09-01')
    expect(listAssets(db, [p]).find((a) => a.id === house)).toMatchObject({ valueCents: 52_000_000, asOf: '2026-09-01', changeCents: 2_000_000, owner: 'Sam' })
    expect(assetHistory(db, p, house).map((h) => [h.asOf, h.valueCents])).toEqual([['2026-01-01', 50_000_000], ['2026-09-01', 52_000_000]])
    updateAssetValue(db, p, house, 49_000_000, '2025-06-01') // an older value only goes into the history
    expect(listAssets(db, [p]).find((a) => a.id === house)!.valueCents).toBe(52_000_000)
    updateAsset(db, p, house, { name: 'Family home' })
    expect(() => createAsset(db, p, { name: 'family home', kind: 'property', valueCents: 1, asOf: '2026-01-01' })).toThrow(/already have something called/)
    deleteAsset(db, p, house)
    expect(netWorth(db, [p]).assetsCents).toBe(1_500_000)
    expect(() => createAsset(db, p, { name: 'X', kind: 'boat' as never, valueCents: 1, asOf: '2026-01-01' })).toThrow(/kind of thing/)
    expect(() => createAsset(db, p, { name: 'Y', kind: 'other', valueCents: -1, asOf: '2026-01-01' })).toThrow(/cannot be negative/)
  })
})

describe('how paying off a loan is going', () => {
  it('shows what was owed, what is paid, every payment, the pace, and the history', () => {
    const osap = createDebt(db, p, 'OSAP', 1_200_000, '2026-04-01')
    const pay = (date: string, cents: number) => linkPaymentToDebt(db, add(-cents, 'NSLSC', 'expense', null, date), osap)
    pay('2026-05-05', 15_000); pay('2026-06-05', 15_000); pay('2026-07-05', 15_000)
    const d = debtDetail(db, p, osap, '2026-07-20')
    expect(d).toMatchObject({ startCents: 1_200_000, startAsOf: '2026-04-01', balanceCents: 1_155_000, paidDownCents: 45_000, paymentsTotalCents: 45_000 })
    expect(d.percentPaid).toBeCloseTo(0.0375, 4)
    expect(d.payments.map((x) => x.date)).toEqual(['2026-07-05', '2026-06-05', '2026-05-05'])
    expect(d.monthlyAverageCents).toBe(15_000) // three months of $150
    expect(d.monthsLeft).toBe(77)
    expect(d.history.map((h) => h.balanceCents)).toEqual([1_200_000, 1_185_000, 1_170_000, 1_155_000])
    const none = debtDetail(db, p, createDebt(db, p, 'Car', 500_000, '2026-01-01'), '2026-07-20')
    expect(none).toMatchObject({ payments: [], monthlyAverageCents: null, monthsLeft: null, percentPaid: 0 })
    expect(() => debtDetail(db, p, 9999, '2026-07-20')).toThrow(/no longer exists/)
  })
})

describe('matching the bank when something is pending', () => {
  it('keeps matching the posted balance and tells the person what the pending charges will do', () => {
    add(-100000, 'BUY', 'expense', null, '2026-09-01', card)
    const c = checkBalance(db, p, card, 341_763, 18_099)
    expect(c).toMatchObject({ bankCents: -341_763, pendingCents: 18_099, afterPendingCents: -359_862 })
    expect(c.warnings.join(' ')).toMatch(/180\.99 pending.*3598\.62/)
    expect(checkBalance(db, p, card, 341_763).pendingCents).toBeNull()
    expect(() => checkBalance(db, p, card, 341_763, -5)).toThrow(/positive amount/)
  })
})
