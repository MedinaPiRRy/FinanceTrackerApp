import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createAccount, setCreditLimit } from '../src/db/accounts'
import { listAccounts, getDashboard } from '../src/db/queries'
import { cardInsights } from '../src/core/insights'

let db: Db
let p: number, q: number, card: number, chq: number
beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('a', 'A')").run().lastInsertRowid)
  q = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('b', 'B')").run().lastInsertRowid)
  chq = createAccount(db, p, { name: 'Chequing', type: 'chequing' })
  card = createAccount(db, p, { name: 'Visa', type: 'credit_card', openingCents: 150000, creditLimitCents: 400000 })
})

describe('credit limit', () => {
  it('is returned with the account', () => {
    expect(listAccounts(db, p).find((a) => a.id === card)).toMatchObject({ creditLimitCents: 400000, valueCents: -150000 })
    expect(listAccounts(db, p).find((a) => a.id === chq)!.creditLimitCents).toBeNull()
  })

  it('can be changed or removed later', () => {
    setCreditLimit(db, p, card, 500000)
    expect(listAccounts(db, p).find((a) => a.id === card)!.creditLimitCents).toBe(500000)
    setCreditLimit(db, p, card, null)
    expect(listAccounts(db, p).find((a) => a.id === card)!.creditLimitCents).toBeNull()
  })

  it('only applies to your own credit cards, with a sensible amount', () => {
    expect(() => setCreditLimit(db, p, chq, 100000)).toThrow(/Only credit cards/)
    expect(() => setCreditLimit(db, q, card, 100000)).toThrow(/no longer exists/)
    expect(() => setCreditLimit(db, p, card, 0)).toThrow(/greater than zero/)
    expect(() => setCreditLimit(db, p, card, -5)).toThrow(/greater than zero/)
    expect(() => setCreditLimit(db, p, card, 10.5)).toThrow(/greater than zero/)
    expect(listAccounts(db, p).find((a) => a.id === card)!.creditLimitCents).toBe(400000)
  })
})

describe('card utilisation insight', () => {
  it('flags cards at or above 30% of their limit, highest first, at most two', () => {
    const r = cardInsights([
      { name: 'Low', owedCents: 10000, limitCents: 400000 },
      { name: 'Edge', owedCents: 120000, limitCents: 400000 },
      { name: 'High', owedCents: 350000, limitCents: 400000 },
      { name: 'Mid', owedCents: 200000, limitCents: 400000 }
    ])
    expect(r.map((i) => i.title)).toEqual(['High is using 88% of its credit limit', 'Mid is using 50% of its credit limit'])
    expect(r[0]).toMatchObject({ tone: 'warn', ref: { page: 'accounts' }, detail: '$3,500.00 owed against a $4,000.00 limit.' })
    expect(cardInsights([{ name: 'Edge', owedCents: 120000, limitCents: 400000 }])).toHaveLength(1) // exactly 30% counts
    expect(cardInsights([{ name: 'None', owedCents: 5000, limitCents: 0 }])).toEqual([])
  })

  it('appears on the dashboard only for cards that have a limit and a balance', () => {
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,'2026-09-05',-2000,'x','expense','import','k1')").run(p, chq)
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,'2026-08-05',-2000,'x','expense','import','k2')").run(p, chq)
    const has = () => getDashboard(db, p, '2026-09', '2026-10-04')!.insights.some((i) => /credit limit/.test(i.title))
    expect(has()).toBe(true) // $1,500 on a $4,000 card is 38%
    setCreditLimit(db, p, card, null)
    expect(has()).toBe(false)
    setCreditLimit(db, p, card, 4000000)
    expect(has()).toBe(false) // 3.75%
  })
})
