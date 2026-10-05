import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createRecurring, updateRecurring, deleteRecurring, type RecurringInput } from '../src/db/recurringManage'
import { listRecurring, listCashBills } from '../src/db/queries'
import { suggestRecurring } from '../src/db/recurringDetect'

let db: Db
let p: number, q: number, chq: number, cash: number, otherChq: number
const input = (over: Partial<RecurringInput> = {}): RecurringInput => ({ name: 'Phone plan', direction: 'expense', accountId: chq, amountCents: 6500, frequency: 'monthly', ...over })

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('a', 'A')").run().lastInsertRowid)
  q = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('b', 'B')").run().lastInsertRowid)
  const acct = (profile: number, name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id, name, type) VALUES (?,?,?)').run(profile, name, type).lastInsertRowid)
  chq = acct(p, 'Chequing', 'chequing'); cash = acct(p, 'Cash', 'cash'); otherChq = acct(q, 'Chequing', 'chequing')
})

describe('adding by hand', () => {
  it('creates an active manual item that counts in the monthly total', () => {
    const id = createRecurring(db, p, input({ notes: ' family plan ' }))
    expect(listRecurring(db, p)).toEqual([expect.objectContaining({ id, name: 'Phone plan', direction: 'expense', accountId: chq, amountCents: 6500, frequency: 'monthly', status: 'active', countsInBudget: true, monthlyCents: 6500, notes: 'family plan' })])
    expect(db.prepare('SELECT source FROM recurring WHERE id = ?').get(id)).toEqual({ source: 'manual' })
  })

  it('income never counts as a bill, and a bill can be left out of the total', () => {
    const inc = createRecurring(db, p, input({ name: 'Pay', direction: 'income', amountCents: 200000, frequency: 'biweekly', countsInBudget: true }))
    const out = createRecurring(db, p, input({ name: 'Gift', countsInBudget: false }))
    const rows = listRecurring(db, p)
    expect(rows.find((r) => r.id === inc)!.countsInBudget).toBe(false)
    expect(rows.find((r) => r.id === out)!.countsInBudget).toBe(false)
  })

  it('a bill paid from the cash wallet shows up as a cash bill', () => {
    createRecurring(db, p, input({ name: 'Rent share', accountId: cash }))
    expect(listCashBills(db, p).map((b) => b.name)).toEqual(['Rent share'])
  })

  it('can be tied to no account at all', () => {
    createRecurring(db, p, input({ accountId: null }))
    expect(listRecurring(db, p)[0]!.accountId).toBeNull()
  })

  it('refuses bad input with a message that says what to fix', () => {
    const bad = (o: Partial<RecurringInput>, re: RegExp) => expect(() => createRecurring(db, p, input(o))).toThrow(re)
    bad({ name: '   ' }, /name/)
    bad({ name: 'x'.repeat(81) }, /80 characters/)
    bad({ amountCents: 0 }, /greater than zero/)
    bad({ amountCents: 12.5 }, /greater than zero/)
    bad({ frequency: 'daily' as never }, /how often/)
    bad({ direction: 'both' as never }, /income or a bill/)
    bad({ accountId: otherChq }, /your own accounts/)
    bad({ accountId: 9999 }, /your own accounts/)
    expect(listRecurring(db, p)).toEqual([])
  })
})

describe('editing', () => {
  it('changes every field and can cancel or reactivate', () => {
    const id = createRecurring(db, p, input())
    updateRecurring(db, p, id, input({ name: 'Mobile', amountCents: 7000, frequency: 'quarterly', accountId: cash, status: 'cancelled' }))
    expect(listRecurring(db, p)[0]).toMatchObject({ name: 'Mobile', amountCents: 7000, frequency: 'quarterly', accountId: cash, status: 'cancelled' })
    updateRecurring(db, p, id, input({ status: 'active' }))
    expect(listRecurring(db, p)[0]!.status).toBe('active')
  })

  it('leaves the status alone when none is given, and keeps what the app found it by', () => {
    const id = createRecurring(db, p, input({ status: 'cancelled' }))
    db.prepare("UPDATE recurring SET match_key = 'ROGERS WIRELESS' WHERE id = ?").run(id)
    updateRecurring(db, p, id, input({ amountCents: 7100 }))
    expect(db.prepare('SELECT status, match_key k, amount_cents a FROM recurring WHERE id = ?').get(id)).toEqual({ status: 'cancelled', k: 'ROGERS WIRELESS', a: 7100 })
  })

  it('cannot touch another person\'s item or use their account', () => {
    const id = createRecurring(db, q, input({ accountId: otherChq }))
    expect(() => updateRecurring(db, p, id, input())).toThrow(/no longer exists/)
    const mine = createRecurring(db, p, input())
    expect(() => updateRecurring(db, p, mine, input({ accountId: otherChq }))).toThrow(/your own accounts/)
    expect(() => updateRecurring(db, p, 9999, input())).toThrow(/no longer exists/)
  })
})

describe('deleting', () => {
  it('removes the item and leaves the transactions alone', () => {
    const id = createRecurring(db, p, input())
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,'2026-09-01',-6500,'ROGERS','expense','import','x1')").run(p, chq)
    deleteRecurring(db, p, id)
    expect(listRecurring(db, p)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n).toBe(1)
  })

  it('an item the app found is remembered as "not recurring", so it is not suggested straight back', () => {
    for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, source, fingerprint) VALUES (?,?,?,?,'NETFLIX.COM','NETFLIX.COM','expense','import',?)").run(p, chq, `${m}-09`, -1649, `n${m}`)
    const id = createRecurring(db, p, input({ name: 'Netflix', amountCents: 1649 }))
    db.prepare("UPDATE recurring SET match_key = 'NETFLIX.COM', source = 'detected' WHERE id = ?").run(id)
    deleteRecurring(db, p, id)
    expect(suggestRecurring(db, p, '2026-10-04')).toEqual([])
  })

  it('refuses another person\'s item', () => {
    const id = createRecurring(db, q, input({ accountId: otherChq }))
    expect(() => deleteRecurring(db, p, id)).toThrow(/no longer exists/)
    expect(listRecurring(db, q)).toHaveLength(1)
  })
})
