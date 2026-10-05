import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, ensureHouseholdProfile, type Db } from '../src/db/open'
import { createAccount, renameAccount, closeAccount, reopenAccount, moveAccount } from '../src/db/accounts'
import { payeeKey, getPartnerAliases, setPartnerAliases, isPartnerPayee, partnerOf } from '../src/db/partners'
import { resolveReview, listReviewQueue } from '../src/db/review'
import { buildPreview, commitImport, type CommitRow } from '../src/db/import'
import { parseStatement } from '../src/core/statement'
import { getHouseholdOverview, listCategoryGroups, setCategoryGroup, listGroupNames, createHouseholdBudget, updateHouseholdBudget, deleteHouseholdBudget, householdBudgetReport, listHouseholdGoals, listHouseholdAccounts } from '../src/db/household'
import { createGoal } from '../src/db/goals'
import { queryTxns, getHouseholdProfile, listProfiles, getDashboard } from '../src/db/queries'
import { createRecurringForTest } from './helpers'

let db: Db
let d: number, b: number, h: number // alex, sam, household
let dChq: number, bChq: number
let dDining: number, bDining: number, dGroc: number, bGroc: number, dPay: number, bPay: number
let n = 0

const tx = (profile: number, account: number, date: string, cents: number, desc: string, kind: string, cat: number | null = null, extra: { cp?: number; review?: string; raw?: string } = {}) =>
  Number(db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, counterparty_profile_id, review_reason, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,'manual',?)`)
    .run(profile, account, date, cents, desc, extra.raw ?? null, kind, cat, extra.cp ?? null, extra.review ?? null, `h${n++}`).lastInsertRowid)

beforeEach(() => {
  db = openDb(':memory:')
  d = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('alex','Alex')").run().lastInsertRowid)
  b = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('sam','Sam')").run().lastInsertRowid)
  h = ensureHouseholdProfile(db)
  const cat = (p: number, name: string, kind = 'expense') => Number(db.prepare('INSERT INTO category (profile_id,name,kind) VALUES (?,?,?)').run(p, name, kind).lastInsertRowid)
  dChq = createAccount(db, d, { name: 'Chequing', type: 'chequing' })
  bChq = createAccount(db, b, { name: 'Chequing', type: 'chequing' })
  dDining = cat(d, 'Fast Food & Dining'); bDining = cat(b, 'Dining & Takeout')
  dGroc = cat(d, 'Groceries & Convenience'); bGroc = cat(b, 'Groceries & Household')
  dPay = cat(d, 'Salary', 'income'); bPay = cat(b, 'Wages', 'income')
})

describe('the household profile', () => {
  it('always exists, is not one of the two people, and comes with starter categories', () => {
    expect(listProfiles(db).map((p) => p.slug)).toEqual(['alex', 'sam'])
    expect(h).toBeGreaterThan(0)
    expect((db.prepare('SELECT COUNT(*) n FROM category WHERE profile_id = ?').get(h) as { n: number }).n).toBeGreaterThan(8)
    expect(partnerOf(db, d)).toEqual({ id: b, name: 'Sam' })
    expect(partnerOf(db, b)).toEqual({ id: d, name: 'Alex' })
  })
})

describe('managing accounts', () => {
  it('creates accounts with the right sign for debts, and refuses duplicates and bad input', () => {
    const card = createAccount(db, d, { name: 'Travel Visa', type: 'credit_card', openingCents: 25000, creditLimitCents: 500000 })
    expect((db.prepare('SELECT opening_balance_cents o FROM account WHERE id = ?').get(card) as { o: number }).o).toBe(-25000) // owed is negative
    const sav = createAccount(db, d, { name: 'Savings', type: 'savings', openingCents: 100000 })
    expect((db.prepare('SELECT opening_balance_cents o FROM account WHERE id = ?').get(sav) as { o: number }).o).toBe(100000)
    expect(() => createAccount(db, d, { name: 'savings', type: 'savings' })).toThrow(/already an account/)
    expect(() => createAccount(db, d, { name: '  ', type: 'savings' })).toThrow(/name/)
    expect(() => createAccount(db, d, { name: 'x', type: 'cash' })).toThrow(/Cash wallet/)
    expect(() => createAccount(db, d, { name: 'y', type: 'savings', openingCents: -5 })).toThrow(/negative/)
    createAccount(db, b, { name: 'Savings', type: 'savings' }) // same name for the other person is fine
  })
  it('renames within the owner only', () => {
    const a = createAccount(db, d, { name: 'Old', type: 'savings' })
    renameAccount(db, d, a, 'New')
    expect((db.prepare('SELECT name FROM account WHERE id = ?').get(a) as { name: string }).name).toBe('New')
    expect(() => renameAccount(db, b, a, 'Hijack')).toThrow(/no longer exists/)
    expect(() => renameAccount(db, d, a, 'Chequing')).toThrow(/already an account/)
  })
  it('closing an account that still has money asks first, and the history stays', () => {
    const a = createAccount(db, d, { name: 'Savings', type: 'savings', openingCents: 5000 })
    expect(closeAccount(db, d, a)).toEqual({ closed: false, balanceCents: 5000 })
    expect((db.prepare('SELECT archived x FROM account WHERE id = ?').get(a) as { x: number }).x).toBe(0)
    expect(closeAccount(db, d, a, { confirmBalance: true })).toMatchObject({ closed: true })
    reopenAccount(db, d, a)
    tx(d, a, '2026-09-01', -5000, 'Withdrawal', 'transfer')
    expect(closeAccount(db, d, a)).toMatchObject({ closed: true, balanceCents: 0 })
    expect((db.prepare('SELECT COUNT(*) n FROM txn WHERE account_id = ?').get(a) as { n: number }).n).toBe(1)
  })
  it('the Cash wallet cannot be closed or moved', () => {
    const cash = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Cash','cash')").run(d).lastInsertRowid)
    expect(() => closeAccount(db, d, cash)).toThrow(/Cash wallet/)
    expect(() => moveAccount(db, cash, h)).toThrow(/Cash wallet/)
  })
})

describe('sharing an account (moving it to the household and back)', () => {
  it('moves the account and all its transactions, matching categories by name and creating missing ones', () => {
    const sav = createAccount(db, d, { name: 'Joint Savings', type: 'savings' })
    const pets = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Pets','expense')").run(d).lastInsertRowid)
    tx(d, sav, '2026-09-02', 90000, 'Deposit', 'transfer')
    tx(d, sav, '2026-09-03', -3000, 'Vet', 'expense', pets)
    tx(d, sav, '2026-09-04', -2000, 'Gift', 'expense', (db.prepare("SELECT id FROM category WHERE profile_id = ? AND name = 'Gifts'").get(h) as { id: number }).id ? dDining : dDining) // category from alex
    const r = moveAccount(db, sav, h)
    expect(r.movedTransactions).toBe(3)
    expect(r.createdCategories).toBe(2) // Pets and Fast Food & Dining did not exist in the household list
    expect((db.prepare('SELECT profile_id p FROM account WHERE id = ?').get(sav) as { p: number }).p).toBe(h)
    expect((db.prepare('SELECT DISTINCT profile_id p FROM txn WHERE account_id = ?').all(sav) as { p: number }[])).toEqual([{ p: h }])
    // every moved transaction now points at a household category
    const bad = db.prepare('SELECT COUNT(*) n FROM txn t JOIN category c ON c.id = t.category_id WHERE t.account_id = ? AND c.profile_id <> ?').get(sav, h) as { n: number }
    expect(bad.n).toBe(0)
    // and Alex no longer sees it
    expect(listHouseholdAccounts(db).find((a) => a.id === sav)).toMatchObject({ owner: 'Household', ownerKind: 'household' })
    expect(getDashboard(db, d)).toBeNull()
    // move it back to Sam
    moveAccount(db, sav, b)
    expect((db.prepare('SELECT DISTINCT profile_id p FROM txn WHERE account_id = ?').all(sav) as { p: number }[])).toEqual([{ p: b }])
  })
  it('refuses while a goal or a recurring bill still depends on it, or the name clashes', () => {
    const card = createAccount(db, d, { name: 'Visa', type: 'credit_card', openingCents: 10000 })
    createGoal(db, d, { name: 'Clear Visa', kind: 'debt', debtItems: [{ accountId: card }] })
    expect(() => moveAccount(db, card, h)).toThrow(/goal "Clear Visa"/)
    const sav = createAccount(db, d, { name: 'Savings', type: 'savings' })
    createRecurringForTest(db, d, 'Transfer to savings', sav)
    expect(() => moveAccount(db, sav, h)).toThrow(/recurring item "Transfer to savings"/)
    const x = createAccount(db, d, { name: 'Same', type: 'savings' })
    createAccount(db, h, { name: 'Same', type: 'savings' })
    expect(() => moveAccount(db, x, h)).toThrow(/already an account called "Same"/)
    expect(() => moveAccount(db, x, d)).toThrow(/already belongs/)
  })
  it('a move changes nothing for the other person', () => {
    const sav = createAccount(db, d, { name: 'Joint', type: 'savings' })
    tx(b, bChq, '2026-09-02', -1000, 'Sam lunch', 'expense', bDining)
    moveAccount(db, sav, h)
    expect(queryTxns(db, b).total).toBe(1)
  })
})

describe('between us: money to and from the other person', () => {
  it('recognises names the user has told it about, from either bank wording', () => {
    setPartnerAliases(db, d, ['Jordan Lee', '  ', 'Sam', 'Jordan Lee'])
    expect(getPartnerAliases(db, d)).toEqual(['Jordan Lee', 'Sam']) // blanks and repeats dropped
    expect(payeeKey('Internet Banking E-TRANSFER 900000000001 Jordan Lee')).toBe('JORDAN LEE')
    expect(isPartnerPayee(db, d, 'Internet Banking E-TRANSFER 900000000001 Jordan Lee')).toBe(true)
    expect(isPartnerPayee(db, d, 'E-Transfer from Jordan Lee')).toBe(true)
    expect(isPartnerPayee(db, d, 'E-Transfer to Sam (between us)')).toBe(true)
    expect(isPartnerPayee(db, d, 'Internet Banking E-TRANSFER 1 Pat Kim')).toBe(false)
    expect(isPartnerPayee(db, b, 'E-Transfer from Jordan Lee')).toBe(false) // aliases belong to one person
  })
  it('resolving as "between us" makes it a transfer for both, records the other person and teaches the name', () => {
    const id = tx(d, dChq, '2026-09-10', -12000, 'E-Transfer to Jordan Lee', 'unclassified', null, { review: 'E-transfer sent', raw: 'Internet Banking E-TRANSFER 105 Jordan Lee' })
    resolveReview(db, id, { kind: 'between_us', partnerProfileId: b })
    expect(db.prepare('SELECT kind, counterparty_profile_id c, review_reason r, category_id cat FROM txn WHERE id = ?').get(id)).toEqual({ kind: 'transfer', c: b, r: null, cat: null })
    expect(getPartnerAliases(db, d)).toEqual(['Jordan Lee'])
    expect(() => resolveReview(db, tx(d, dChq, '2026-09-11', -500, 'x', 'unclassified', null, { review: 'x' }), { kind: 'between_us', partnerProfileId: d })).toThrow(/other person/)
    expect(() => resolveReview(db, tx(d, dChq, '2026-09-11', -500, 'y', 'unclassified', null, { review: 'x' }), { kind: 'between_us', partnerProfileId: h })).toThrow(/other person/) // the household is not "the other person"
  })
  it('a later import recognises the same person automatically: no review, counted for nobody', () => {
    setPartnerAliases(db, d, ['Jordan Lee'])
    const pv = buildPreview(db, d, dChq, parseStatement([['2026-10-01', 'Internet Banking E-TRANSFER 900000000001 Jordan Lee', '50.00', ''], ['2026-10-02', 'Internet Banking E-TRANSFER 900000000002 Someone Else', '20.00', '']]), 'x.csv')
    expect(pv.rows[0]).toMatchObject({ kind: 'transfer', reviewReason: null, counterpartyProfileId: b })
    expect(pv.rows[0]!.description).toBe('E-Transfer to Jordan Lee (between us)')
    expect(pv.rows[1]).toMatchObject({ kind: 'unclassified' }) // a stranger is still for the user to decide
    const rows: CommitRow[] = pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
    commitImport(db, d, dChq, 'x.csv', rows, { learnFromDuplicates: false })
    expect(db.prepare("SELECT kind, counterparty_profile_id c FROM txn WHERE description LIKE '%between us%'").get()).toEqual({ kind: 'transfer', c: b })
    expect(listReviewQueue(db, d).map((q) => q.description)).toEqual(['E-Transfer to Someone Else'])
  })
  it('only a transfer can be between us, and only with the other person', () => {
    const pv = buildPreview(db, d, dChq, parseStatement([['2026-10-01', 'Coffee shop', '5.00', '']]), 'x.csv')
    const base = pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
    expect(() => commitImport(db, d, dChq, 'x', base.map((r) => ({ ...r, counterpartyProfileId: b })), { learnFromDuplicates: false })).toThrow(/only a transfer/)
    expect(() => commitImport(db, d, dChq, 'x', base.map((r) => ({ ...r, kind: 'transfer' as const, categoryId: null, counterpartyProfileId: d })), { learnFromDuplicates: false })).toThrow(/other person/)
  })
  it('a transfer into a shared account creates the shared-side leg and marks both as movement', () => {
    const sav = createAccount(db, h, { name: 'Joint Savings', type: 'savings' })
    const id = tx(d, dChq, '2026-09-12', -20000, 'To joint', 'unclassified', null, { review: 'where?' })
    resolveReview(db, id, { kind: 'transfer', counterAccountId: sav })
    const legs = db.prepare('SELECT profile_id p, amount_cents c, counterparty_profile_id cp FROM txn WHERE transfer_group IS NOT NULL ORDER BY amount_cents').all()
    expect(legs).toEqual([{ p: d, c: -20000, cp: h }, { p: h, c: 20000, cp: d }])
  })
})

describe('household overview', () => {
  beforeEach(() => {
    tx(d, dChq, '2026-09-01', 200000, 'Pay', 'income', dPay)
    tx(b, bChq, '2026-09-02', 300000, 'Pay', 'income', bPay)
    tx(d, dChq, '2026-09-05', -4000, 'Burgers', 'expense', dDining)
    tx(b, bChq, '2026-09-06', -6000, 'Pizza', 'expense', bDining) // same group "Dining", different category name
    tx(d, dChq, '2026-09-07', -9000, 'Food shop', 'expense', dGroc)
    tx(b, bChq, '2026-09-08', 500, 'Refund', 'refund', bDining)
    tx(d, dChq, '2026-09-10', -12000, 'E-Transfer to Sam', 'transfer', null, { cp: b })
    tx(b, bChq, '2026-09-10', 12000, 'E-Transfer from Alex', 'transfer', null, { cp: d })
    tx(d, dChq, '2026-09-11', -2000, 'Unreviewed', 'unclassified', null, { review: 'what?' })
  })
  it('adds up both people (and shared accounts) with the split kept, ignoring transfers and unreviewed rows', () => {
    const o = getHouseholdOverview(db, undefined)!
    expect(o.month).toBe('2026-09')
    expect(o.combined).toMatchObject({ incomeCents: 500000, expenseCents: 4000 + 6000 + 9000 - 500, netCents: 500000 - 18500 })
    expect(o.perOwner.find((x) => x.profileId === d)).toMatchObject({ incomeCents: 200000, expenseCents: 13000 })
    expect(o.perOwner.find((x) => x.profileId === b)).toMatchObject({ incomeCents: 300000, expenseCents: 5500 })
    expect(o.perOwner.find((x) => x.profileId === h)).toMatchObject({ incomeCents: 0, expenseCents: 0 })
  })
  it('combines differently named categories into groups, with each person\'s share', () => {
    const o = getHouseholdOverview(db, '2026-09')!
    const dining = o.groups.find((g) => g.group === 'Dining')!
    expect(dining.totalCents).toBe(9500) // 40 + 60 - 5
    expect(dining.perOwner).toEqual({ [d]: 4000, [b]: 5500 })
    expect(o.groups.find((g) => g.group === 'Groceries')!.perOwner).toEqual({ [d]: 9000 })
  })
  it('shows movement between you as movement, not spending, and who put money into shared accounts', () => {
    const sav = createAccount(db, h, { name: 'Joint', type: 'savings' })
    tx(b, bChq, '2026-09-15', -30000, 'To joint', 'transfer', null, { cp: h })
    tx(h, sav, '2026-09-15', 30000, 'From Sam', 'transfer', null, { cp: b })
    const o = getHouseholdOverview(db, '2026-09')!
    expect(o.movement.betweenUs).toEqual([{ fromId: d, from: 'Alex', to: 'Sam', sentCents: 12000 }])
    expect(o.movement.sharedAccounts).toEqual([{ personId: b, person: 'Sam', putInCents: 30000, takenOutCents: 0 }])
    expect(o.combined.expenseCents).toBe(18500) // unchanged by any of it
    expect(o.facts.some((f) => f.includes('Alex sent Sam $120.00') && f.includes('not spending'))).toBe(true)
  })
  it('totals accounts by owner; closed accounts and unvalued investments are left out', () => {
    createAccount(db, d, { name: 'Visa', type: 'credit_card', openingCents: 40000 })
    const old = createAccount(db, b, { name: 'Old', type: 'savings', openingCents: 99999 })
    closeAccount(db, b, old, { confirmBalance: true })
    createAccount(db, b, { name: 'Home fund', type: 'investment' })
    createAccount(db, h, { name: 'Joint Savings', type: 'savings', openingCents: 70000 })
    const o = getHouseholdOverview(db, '2026-09')!
    expect(o.money.perOwner.find((x) => x.profileId === d)).toMatchObject({ owedCents: 40000 })
    expect(o.money.perOwner.find((x) => x.profileId === h)).toMatchObject({ assetsCents: 70000 })
    expect(o.money.owedCardsCents).toBe(40000)
    expect(o.money.assetsCents).toBe(200000 + 300000 - 12000 + 12000 - 4000 - 9000 - 2000 - 6000 + 500 + 70000 + 0 - 0) // chequing balances + shared savings
  })
  it('is null with no data, and individual dashboards are unaffected by household activity', () => {
    const empty = openDb(':memory:')
    expect(getHouseholdOverview(empty, undefined)).toBeNull()
    expect(getDashboard(db, d, '2026-09')!.summary.incomeCents).toBe(200000)
    expect(getDashboard(db, b, '2026-09')!.summary.incomeCents).toBe(300000)
  })
})

describe('category groups', () => {
  it('lists every spending category with its group and lets you override it', () => {
    const rows = listCategoryGroups(db)
    expect(rows.find((r) => r.name === 'Dining & Takeout')).toMatchObject({ group: 'Dining', overridden: false, owner: 'Sam' })
    setCategoryGroup(db, bDining, 'Eating out')
    expect(listCategoryGroups(db).find((r) => r.id === bDining)).toMatchObject({ group: 'Eating out', overridden: true })
    setCategoryGroup(db, bDining, null)
    expect(listCategoryGroups(db).find((r) => r.id === bDining)).toMatchObject({ group: 'Dining', overridden: false })
    expect(() => setCategoryGroup(db, dPay, 'x')).toThrow(/Only spending categories/)
    expect(listGroupNames(db)).toContain('Groceries')
  })
  it('re-grouping moves that spending in the overview', () => {
    tx(b, bChq, '2026-09-06', -6000, 'Pizza', 'expense', bDining)
    setCategoryGroup(db, bDining, 'Date nights')
    const o = getHouseholdOverview(db, '2026-09')!
    expect(o.groups.map((g) => g.group)).toEqual(['Date nights'])
  })
})

describe('household budgets', () => {
  beforeEach(() => {
    tx(d, dChq, '2026-09-01', 200000, 'Pay', 'income', dPay)
    tx(d, dChq, '2026-09-05', -4000, 'Burgers', 'expense', dDining)
    tx(b, bChq, '2026-09-06', -6000, 'Pizza', 'expense', bDining)
    tx(d, dChq, '2026-09-07', -9000, 'Food shop', 'expense', dGroc)
    tx(b, bChq, '2026-09-08', -3000, 'Mystery', 'expense', null)
  })
  it('budgets cover category groups across everyone and report each person\'s part', () => {
    createHouseholdBudget(db, 'Eating out', 11000, ['Dining'])
    const r = householdBudgetReport(db, '2026-09')
    const line = r.lines[0]!
    expect(line).toMatchObject({ name: 'Eating out', spentCents: 10000, remainingCents: 1000, state: 'near' }) // 91% of the limit
    expect(line.perOwner).toEqual([{ profileId: d, name: 'Alex', cents: 4000 }, { profileId: b, name: 'Sam', cents: 6000 }])
    expect(r.unbudgeted).toEqual([{ group: 'Groceries', cents: 9000 }, { group: 'Uncategorized', cents: 3000 }])
    expect(r.totals).toEqual({ budgetCents: 11000, spentCents: 10000, remainingCents: 1000 })
  })
  it('a group can be in only one budget, must exist, and edits/deletes work', () => {
    const id = createHouseholdBudget(db, 'Food', 50000, ['Dining', 'Groceries'])
    expect(() => createHouseholdBudget(db, 'More food', 100, ['Dining'])).toThrow(/already in the "Food" budget/)
    expect(() => createHouseholdBudget(db, 'Ghost', 100, ['Nope'])).toThrow(/not a category group/)
    expect(() => createHouseholdBudget(db, 'food', 100, [])).toThrow(/already a budget called/)
    expect(() => createHouseholdBudget(db, 'Neg', -1, [])).toThrow(/negative/)
    updateHouseholdBudget(db, id, { monthlyCents: 60000, groups: ['Dining'] })
    expect(householdBudgetReport(db, '2026-09').lines[0]).toMatchObject({ budgetCents: 60000, spentCents: 10000 })
    deleteHouseholdBudget(db, id)
    expect(householdBudgetReport(db, '2026-09').lines).toEqual([])
    expect(() => deleteHouseholdBudget(db, id)).toThrow(/no longer exists/)
  })
  it('does not let a group disappear from under a budget', () => {
    const pets = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Pets','expense')").run(d).lastInsertRowid)
    createHouseholdBudget(db, 'Animals', 5000, ['Pets'])
    expect(() => setCategoryGroup(db, pets, 'Zoo')).toThrow(/used by the household budget "Animals"/) // the only category in that group
    // but a group that another category still provides is fine to leave
    createHouseholdBudget(db, 'Eating out', 12000, ['Dining'])
    setCategoryGroup(db, dDining, 'Date nights')
    expect(householdBudgetReport(db, '2026-09').lines.find((l) => l.name === 'Eating out')!.spentCents).toBe(6000) // only Sam is still in Dining
  })
})

describe('household goals', () => {
  it('a household goal can use either person\'s account; a personal goal still cannot', () => {
    const fhsa = createAccount(db, b, { name: 'Home buyer account', type: 'investment' })
    createGoal(db, h, { name: 'House fund', kind: 'account', targetCents: 6_000_000, accountId: fhsa })
    expect(() => createGoal(db, d, { name: 'Sneaky', kind: 'account', targetCents: 100, accountId: fhsa })).toThrow(/your own accounts/)
    const wedding = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Wedding','expense')").run(b).lastInsertRowid)
    tx(b, bChq, '2026-09-01', -300000, 'Venue deposit', 'expense', wedding)
    createGoal(db, h, { name: 'Wedding', kind: 'category', targetCents: 5_000_000, categoryId: wedding })
    createGoal(db, b, { name: 'Sam trip', kind: 'manual', targetCents: 10000 })
    const goals = listHouseholdGoals(db, '2026-10-03')
    expect(goals.map((g) => [g.owner, g.name]).sort()).toEqual([['Sam', 'Sam trip'], ['Household', 'House fund'], ['Household', 'Wedding']].sort())
    expect(goals.find((g) => g.name === 'Wedding')!.progress.achievedCents).toBe(300000)
  })
  it('a household payoff goal can cover both people\'s cards', () => {
    const c1 = createAccount(db, d, { name: 'Visa', type: 'credit_card', openingCents: 100000 })
    const c2 = createAccount(db, b, { name: 'Travel Visa', type: 'credit_card', openingCents: 50000 })
    createGoal(db, h, { name: 'Clear all cards', kind: 'debt', debtItems: [{ accountId: c1 }, { accountId: c2 }] })
    expect(listHouseholdGoals(db, '2026-10-03').find((g) => g.name === 'Clear all cards')!.targetCents).toBe(150000)
  })
})

describe('transactions across people', () => {
  it('lists everyone with a Person column, and can filter by person or by category group', () => {
    tx(d, dChq, '2026-09-05', -4000, 'Burgers', 'expense', dDining)
    tx(b, bChq, '2026-09-06', -6000, 'Pizza', 'expense', bDining)
    tx(b, bChq, '2026-09-07', -1000, 'Bread', 'expense', bGroc)
    const all = queryTxns(db, [d, b, h])
    expect(all.total).toBe(3)
    expect(all.rows.map((r) => r.person).sort()).toEqual(['Alex', 'Sam', 'Sam'])
    expect(queryTxns(db, [d, b, h], { personId: b }).total).toBe(2)
    expect(queryTxns(db, [d, b, h], { groupName: 'Dining' }).rows.map((r) => r.description).sort()).toEqual(['Burgers', 'Pizza'])
    expect(queryTxns(db, [d, b, h], { groupName: 'Nothing' }).total).toBe(0)
    expect(queryTxns(db, d).total).toBe(1) // one person alone is still just theirs
    expect(queryTxns(db, [], {}).total).toBe(0)
  })
  it('between-us rows show who the other side is', () => {
    tx(d, dChq, '2026-09-10', -12000, 'E-Transfer to Sam', 'transfer', null, { cp: b })
    expect(queryTxns(db, [d, b, h]).rows[0]!.counterparty).toBe('Sam')
  })
})
