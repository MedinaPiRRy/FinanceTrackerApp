import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, ensureHouseholdProfile, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { createBudget, suggestBudgets, createBudgets, listBudgets } from '../src/db/budgets'
import { suggestHouseholdBudgets, createHouseholdBudgets, createHouseholdBudget, listHouseholdBudgets } from '../src/db/household'
import { suggestLimits, lastCompleteMonths } from '../src/core/budgets'

const TODAY = '2026-10-04'
let db: Db
let p: number, q: number, chq: number, qChq: number
let n = 0
const cat = (profile: number, name: string, kind = 'expense') => (db.prepare('SELECT id FROM category WHERE profile_id = ? AND name = ? AND kind = ?').get(profile, name, kind) as { id: number }).id
const tx = (profile: number, account: number, date: string, cents: number, kind: string, category: number | null) =>
  db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,'manual',?)").run(profile, account, date, cents, 'x', kind, category, `s${n++}`)

beforeEach(() => {
  db = openDb(':memory:')
  ;[p, q] = createSetup(db, 'couple', [{ name: 'A', accounts: [{ name: 'Chequing', type: 'chequing' }] }, { name: 'B', accounts: [{ name: 'Chequing', type: 'chequing' }] }]) as [number, number]
  chq = (db.prepare("SELECT id FROM account WHERE profile_id = ? AND name = 'Chequing'").get(p) as { id: number }).id
  qChq = (db.prepare("SELECT id FROM account WHERE profile_id = ? AND name = 'Chequing'").get(q) as { id: number }).id
})

describe('suggestLimits (pure)', () => {
  it('averages over the months given, rounds up to the next $5, drops tiny categories and sorts by size', () => {
    const r = suggestLimits([
      { key: 'a', name: 'Dining', monthlyCents: [10000, 12000, 11200] },
      { key: 'b', name: 'Coffee beans', monthlyCents: [500, 0, 600] }, // averages $3.67: not worth a line
      { key: 'c', name: 'Rent', monthlyCents: [150000, 150000, 150000] },
      { key: 'd', name: 'Gym', monthlyCents: [4000, 4000, 4000] } // already a multiple of $5: unchanged
    ])
    expect(r.map((x) => x.name)).toEqual(['Rent', 'Dining', 'Gym'])
    expect(r.find((x) => x.name === 'Dining')).toMatchObject({ averageCents: 11067, suggestedCents: 11500, highestCents: 12000, monthsWithSpending: 3 })
    expect(r.find((x) => x.name === 'Gym')!.suggestedCents).toBe(4000)
  })
  it('counts a month with no spending as zero, and an empty window gives nothing', () => {
    expect(suggestLimits([{ key: 'a', name: 'Fuel', monthlyCents: [9000, 0, 0] }])[0]).toMatchObject({ averageCents: 3000, suggestedCents: 3000, monthsWithSpending: 1 })
    expect(suggestLimits([{ key: 'a', name: 'x', monthlyCents: [] }])).toEqual([])
  })
  it('lastCompleteMonths skips the current month and crosses year boundaries', () => {
    expect(lastCompleteMonths('2026-10-04')).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(lastCompleteMonths('2026-02-15')).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('suggestBudgets', () => {
  it('uses the last three complete months and ignores the month in progress', () => {
    const dining = cat(p, 'Dining')
    tx(p, chq, '2026-07-10', -10000, 'expense', dining)
    tx(p, chq, '2026-08-10', -12000, 'expense', dining)
    tx(p, chq, '2026-09-10', -11000, 'expense', dining)
    tx(p, chq, '2026-10-02', -90000, 'expense', dining) // this month so far: not part of the average
    tx(p, chq, '2026-06-10', -90000, 'expense', dining) // older than the window
    const r = suggestBudgets(db, p, TODAY)
    expect(r.months).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0]).toMatchObject({ name: 'Dining', categoryId: dining, averageCents: 11000, suggestedCents: 11000 })
  })

  it('does not count months before the first transaction as zero', () => {
    tx(p, chq, '2026-09-10', -30000, 'expense', cat(p, 'Groceries'))
    const r = suggestBudgets(db, p, TODAY)
    expect(r.months).toEqual(['2026-09'])
    expect(r.suggestions[0]).toMatchObject({ name: 'Groceries', averageCents: 30000, suggestedCents: 30000 })
  })

  it('refunds reduce spending; transfers and unreviewed rows never count; categories already budgeted are skipped', () => {
    const groc = cat(p, 'Groceries'), shop = cat(p, 'Shopping'), dining = cat(p, 'Dining')
    tx(p, chq, '2026-09-03', -20000, 'expense', groc)
    tx(p, chq, '2026-09-04', 5000, 'refund', groc)
    tx(p, chq, '2026-09-05', -99999, 'transfer', null)
    tx(p, chq, '2026-09-06', -88888, 'unclassified', null)
    tx(p, chq, '2026-09-07', -40000, 'expense', shop)
    tx(p, chq, '2026-09-08', -15000, 'expense', dining)
    createBudget(db, p, 'Shopping budget', 30000, [shop])
    const r = suggestBudgets(db, p, TODAY)
    expect(r.suggestions.map((s) => [s.name, s.averageCents])).toEqual([['Dining', 15000], ['Groceries', 15000]])
  })

  it('has nothing to suggest without a complete month of history, and never reads another person\'s spending', () => {
    tx(p, chq, '2026-10-02', -5000, 'expense', cat(p, 'Dining'))
    expect(suggestBudgets(db, p, TODAY)).toEqual({ months: [], suggestions: [] })
    tx(q, qChq, '2026-09-02', -50000, 'expense', cat(q, 'Dining'))
    expect(suggestBudgets(db, p, TODAY).suggestions).toEqual([])
    expect(suggestBudgets(db, q, TODAY).suggestions).toHaveLength(1)
  })

  it('avoids a name clash with an existing budget', () => {
    const groc = cat(p, 'Groceries'), dining = cat(p, 'Dining')
    tx(p, chq, '2026-09-03', -20000, 'expense', groc)
    createBudget(db, p, 'Groceries', 10000, [dining]) // a budget called Groceries that covers something else
    expect(suggestBudgets(db, p, TODAY).suggestions[0]!.name).toBe('Groceries (suggested)')
  })

  it('createBudgets is all-or-nothing', () => {
    const groc = cat(p, 'Groceries'), dining = cat(p, 'Dining')
    expect(() => createBudgets(db, p, [{ name: 'Food', monthlyCents: 10000, categoryIds: [groc] }, { name: 'Bad', monthlyCents: -5, categoryIds: [dining] }])).toThrow()
    expect(listBudgets(db, p)).toEqual([])
    createBudgets(db, p, [{ name: 'Food', monthlyCents: 10000, categoryIds: [groc] }, { name: 'Out', monthlyCents: 5000, categoryIds: [dining] }])
    expect(listBudgets(db, p)).toHaveLength(2)
  })
})

describe('suggestHouseholdBudgets', () => {
  it('combines both people by category group, skipping groups already in a household budget', () => {
    ensureHouseholdProfile(db)
    tx(p, chq, '2026-08-05', -20000, 'expense', cat(p, 'Groceries'))
    tx(q, qChq, '2026-08-06', -10000, 'expense', cat(q, 'Groceries'))
    tx(p, chq, '2026-09-05', -20000, 'expense', cat(p, 'Groceries'))
    tx(q, qChq, '2026-09-06', -10000, 'expense', cat(q, 'Groceries'))
    tx(q, qChq, '2026-09-07', -8000, 'expense', cat(q, 'Dining'))
    const r = suggestHouseholdBudgets(db, TODAY)
    expect(r.months).toEqual(['2026-08', '2026-09'])
    expect(r.suggestions[0]).toMatchObject({ group: 'Groceries', averageCents: 30000, suggestedCents: 30000 })
    expect(r.suggestions.find((s) => s.group === 'Dining')).toMatchObject({ averageCents: 4000 })
    createHouseholdBudget(db, 'Food at home', 40000, ['Groceries'])
    expect(suggestHouseholdBudgets(db, TODAY).suggestions.map((s) => s.group)).toEqual(['Dining'])
    createHouseholdBudgets(db, [{ name: 'Dining out', monthlyCents: 5000, groups: ['Dining'] }])
    expect(listHouseholdBudgets(db)).toHaveLength(2)
  })
})
