import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/open'
import { generateSample } from '../src/demo/sample'
import { createSetup, getAppMode } from '../src/db/defaults'
import { createHandlers } from '../src/main/handlers'
import { getDashboard, listProfiles, listAccounts, getHouseholdProfile, listRecurring, listCashBills, listDebts } from '../src/db/queries'
import { listImports } from '../src/db/import'
import { listReviewQueue } from '../src/db/review'
import { getHouseholdOverview, listHouseholdGoals } from '../src/db/household'

const NOW = new Date(2026, 9, 3)

describe('sample data', () => {
  it('single: one person, no partner, no household', () => {
    const db = openDb(':memory:')
    const r = generateSample(db, 'single', NOW)
    expect(r.people).toEqual(['Alex'])
    expect(listProfiles(db)).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'household'").get()).toEqual({ n: 0 })
    expect(getAppMode(db)).toBe('single')
    expect(r.transactions).toBeGreaterThan(150)
    expect((db.prepare('SELECT COUNT(*) n FROM txn WHERE counterparty_profile_id IS NOT NULL').get() as { n: number }).n).toBe(0)
  })

  it('couple: two separate people, between-us transfers, still no household', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple', NOW)
    expect(listProfiles(db).map((p) => p.name)).toEqual(['Alex', 'Sam'])
    expect(db.prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'household'").get()).toEqual({ n: 0 })
    expect((db.prepare('SELECT COUNT(*) n FROM txn WHERE counterparty_profile_id IS NOT NULL').get() as { n: number }).n).toBe(6)
  })

  it('couple + household: shared accounts, budgets and goals exist and the overview works', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple_household', NOW)
    const h = getHouseholdProfile(db)
    expect(listAccounts(db, h.id).map((a) => a.name)).toEqual(['Joint Chequing', 'Joint Savings (house fund)', 'Shared Visa', 'Joint investment'])
    expect(listHouseholdGoals(db, '2026-10-03').some((g) => g.ownerKind === 'household' && g.name === 'House down payment')).toBe(true)
    const o = getHouseholdOverview(db, undefined)
    expect(o).not.toBeNull()
    expect(o!.perOwner.length).toBe(3)
  })

  for (const mode of ['single', 'couple', 'couple_household'] as const) {
    it(`${mode}: bookkeeping is consistent`, () => {
      const db = openDb(':memory:')
      generateSample(db, mode, NOW)
      // every transfer group nets to zero, so transfers never create or destroy money
      const bad = db.prepare('SELECT transfer_group g, SUM(amount_cents) s FROM txn WHERE transfer_group IS NOT NULL GROUP BY transfer_group HAVING s != 0').all()
      expect(bad).toEqual([])
      // income is money in, expenses are money out
      expect(db.prepare("SELECT COUNT(*) n FROM txn WHERE (kind='income' AND amount_cents<=0) OR (kind='expense' AND amount_cents>=0) OR (kind='refund' AND amount_cents<=0)").get()).toEqual({ n: 0 })
      // nothing in the future, and the database is internally consistent
      expect((db.prepare("SELECT COUNT(*) n FROM txn WHERE posted_date > '2026-10-03'").get() as { n: number }).n).toBe(0)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      // every person has something waiting in the review queue, and a dashboard that renders
      for (const p of listProfiles(db)) {
        expect(listReviewQueue(db, p.id).length).toBeGreaterThanOrEqual(3)
        const dash = getDashboard(db, p.id, '2026-09')
        expect(dash).not.toBeNull()
        expect(dash!.summary.incomeCents).toBeGreaterThan(0)
        expect(dash!.summary.expenseCents).toBeGreaterThan(0)
      }
    })
  }

  it('is deterministic: the same setup gives the same data', () => {
    const a = openDb(':memory:'), b = openDb(':memory:')
    generateSample(a, 'couple_household', NOW)
    generateSample(b, 'couple_household', NOW)
    const dump = (d: typeof a) => d.prepare('SELECT posted_date, amount_cents, description, kind FROM txn ORDER BY id').all()
    expect(dump(a)).toEqual(dump(b))
  })
})

describe('sample data shows every feature', () => {
  const NOW2 = new Date(2026, 9, 25)
  it('has debts for both people, a shared card and investment, USD tips, a cash bill, import history and a cancelled item', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple_household', NOW2)
    const [a, b] = (db.prepare("SELECT id FROM profile WHERE kind = 'person' ORDER BY id").all() as { id: number }[]).map((r) => r.id) as [number, number]
    const h = getHouseholdProfile(db).id
    expect(listDebts(db, a).map((d) => d.name)).toEqual(['Student loan'])
    expect(listDebts(db, b).map((d) => d.name)).toEqual(['Car loan'])
    expect(listAccounts(db, h).map((x) => x.type)).toEqual(['chequing', 'savings', 'credit_card', 'investment'])
    expect(listAccounts(db, h).find((x) => x.type === 'investment')!.valueCents).toBeGreaterThan(0)
    expect(listAccounts(db, h).find((x) => x.name === 'Shared Visa')).toMatchObject({ valueCents: expect.any(Number), creditLimitCents: 600000 })
    expect(listRecurring(db, h).map((r) => r.name).sort()).toEqual(['Home insurance', 'Internet', 'Rent'])
    expect(db.prepare("SELECT COUNT(*) n FROM txn WHERE currency = 'USD' AND profile_id = ?").get(b)).toEqual({ n: 3 })
    expect(listCashBills(db, b).map((r) => r.name)).toEqual(['Phone plan (paid in cash)'])
    expect(listRecurring(db, b).filter((r) => r.status === 'cancelled').map((r) => r.name)).toEqual(['Music streaming (old plan)'])
    for (const p of [a, b]) {
      const imports = listImports(db, p)
      expect(imports).toHaveLength(2)
      expect(imports.every((i) => i.rowCount > 0 && i.remaining === i.rowCount && i.undoable)).toBe(true)
    }
  })
  it('the shared card keeps a sensible balance (the payments match the spending)', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple_household', NOW2)
    const card = (db.prepare("SELECT id FROM account WHERE name = 'Shared Visa'").get() as { id: number }).id
    const owed = -(db.prepare('SELECT opening_balance_cents o, (SELECT COALESCE(SUM(amount_cents),0) FROM txn WHERE account_id = account.id) s FROM account WHERE id = ?').get(card) as { o: number; s: number }).o - 0
    expect(owed).toBeGreaterThan(0)
    const bal = (db.prepare('SELECT opening_balance_cents + (SELECT COALESCE(SUM(amount_cents),0) FROM txn WHERE account_id = ?) b FROM account WHERE id = ?').get(card, card) as { b: number }).b
    expect(bal).toBeLessThan(0)
    expect(bal).toBeGreaterThan(-300000)
  })
})

describe('setup for own data', () => {
  it('creates people, starter categories, a Cash wallet and the listed accounts', () => {
    const db = openDb(':memory:')
    const ids = createSetup(db, 'couple', [
      { name: 'Riley', accounts: [{ name: 'Everyday', type: 'chequing' }, { name: 'everyday', type: 'savings' }, { name: 'Cash', type: 'other' }] },
      { name: 'Quinn', accounts: [] }
    ])
    expect(ids).toHaveLength(2)
    expect(listAccounts(db, ids[0]!).map((a) => a.name).sort()).toEqual(['Cash', 'Everyday']) // duplicate and second "Cash" ignored
    expect(db.prepare("SELECT COUNT(*) n FROM category WHERE profile_id = ? AND name = 'Groceries'").get(ids[1]!)).toEqual({ n: 1 })
    expect(getAppMode(db)).toBe('couple')
  })
  it('rejects wrong people counts, blank or equal names, and a second setup', () => {
    const db = openDb(':memory:')
    expect(() => createSetup(db, 'single', [])).toThrow()
    expect(() => createSetup(db, 'couple', [{ name: 'A', accounts: [] }])).toThrow(/both names/)
    expect(() => createSetup(db, 'couple', [{ name: 'A', accounts: [] }, { name: ' a ', accounts: [] }])).toThrow(/different/)
    expect(() => createSetup(db, 'single', [{ name: '  ', accounts: [] }])).toThrow(/name/)
    createSetup(db, 'single', [{ name: 'Solo', accounts: [] }])
    expect(() => createSetup(db, 'single', [{ name: 'Again', accounts: [] }])).toThrow(/already has data/)
  })
  it('a person called "Household" cannot collide with the shared profile', () => {
    const db = openDb(':memory:')
    const [id] = createSetup(db, 'single', [{ name: 'Household', accounts: [] }])
    expect(db.prepare('SELECT slug FROM profile WHERE id = ?').get(id)).toEqual({ slug: 'household-2' })
  })
})

describe('handlers: sample vs own data', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sample-'))

  it('sample data is a separate file; leaving it restores the empty real database', () => {
    const dir = tmp()
    const real = path.join(dir, 'finance.db')
    const h = createHandlers(real)
    expect(h.status()).toMatchObject({ hasData: false, sample: false, mode: null })
    h.startSample('couple_household')
    expect(h.status()).toMatchObject({ hasData: true, sample: true, mode: 'couple_household', dbPath: path.join(dir, 'sample.db') })
    expect(h.profiles()).toHaveLength(2)
    h.endSample()
    expect(fs.existsSync(path.join(dir, 'sample.db'))).toBe(false)
    expect(h.status()).toMatchObject({ hasData: false, sample: false })
    h.close()
  })

  it('real data is never touched by sample mode, and cannot be set up while a sample is open', () => {
    const dir = tmp()
    const h = createHandlers(path.join(dir, 'finance.db'))
    h.setupOwn('single', [{ name: 'Robin', accounts: [{ name: 'Chequing', type: 'chequing' }] }])
    const accountsBefore = h.accounts(h.profiles()[0]!.id).length
    h.startSample('couple')
    expect(h.profiles().map((p) => p.name)).toEqual(['Alex', 'Sam'])
    expect(() => h.setupOwn('single', [{ name: 'Nope', accounts: [] }])).toThrow(/Sample data is open/)
    h.endSample()
    expect(h.profiles().map((p) => p.name)).toEqual(['Robin'])
    expect(h.accounts(h.profiles()[0]!.id)).toHaveLength(accountsBefore)
    h.close()
  })

  it('"couple + household" setup creates the shared household; "couple" does not', () => {
    const a = createHandlers(path.join(tmp(), 'finance.db'))
    a.setupOwn('couple_household', [{ name: 'A', accounts: [] }, { name: 'B', accounts: [] }])
    expect(a.owners().map((o) => o.kind)).toEqual(['person', 'person', 'household'])
    a.close()
    const b = createHandlers(path.join(tmp(), 'finance.db'))
    b.setupOwn('couple', [{ name: 'A', accounts: [] }, { name: 'B', accounts: [] }])
    expect(b.owners().map((o) => o.kind)).toEqual(['person', 'person'])
    b.close()
  })

  it('a leftover state file pointing at a missing sample database falls back to real data', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'app-state.json'), JSON.stringify({ active: 'sample' }))
    const h = createHandlers(path.join(dir, 'finance.db'))
    expect(h.status()).toMatchObject({ sample: false, hasData: false })
    h.close()
  })
})
