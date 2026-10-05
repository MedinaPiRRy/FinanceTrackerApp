import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { addTip, lastRates, cashBalanceCents, convertCents } from '../src/db/cash'
import { queryTxns } from '../src/db/queries'
import { generateSample } from '../src/demo/sample'
import { insightsFor, insightEvidence } from '../src/db/insights'
import { pickBannerTip, type Insight } from '../src/core/insights'

describe('tips in a foreign currency', () => {
  let db: Db
  let p: number
  beforeEach(() => {
    db = openDb(':memory:')
    ;[p] = createSetup(db, 'single', [{ name: 'T', accounts: [] }]) as [number]
  })

  it('converts at the rate typed, keeps the original, and counts the converted amount everywhere', () => {
    const id = addTip(db, p, '2026-10-01', 0, 'Saturday', { currency: 'usd', cents: 2000, rate: 1.37 })
    const row = queryTxns(db, p, {}).rows.find((r) => r.id === id)!
    expect(row).toMatchObject({ amountCents: 2740, currency: 'USD', originalCents: 2000, fxRate: 1.37, kind: 'income' })
    expect(cashBalanceCents(db, p)).toBe(2740)
  })

  it('rounds to the nearest cent', () => {
    expect(convertCents(1999, 1.3725)).toBe(2744) // 2743.5 rounds up
    expect(convertCents(1, 1.37)).toBe(1)
    expect(convertCents(1000, 0.7381)).toBe(738)
  })

  it('remembers the last rate for each currency, and home-currency tips are unchanged', () => {
    addTip(db, p, '2026-10-01', 0, undefined, { currency: 'USD', cents: 1000, rate: 1.36 })
    addTip(db, p, '2026-10-02', 0, undefined, { currency: 'USD', cents: 1000, rate: 1.38 })
    addTip(db, p, '2026-10-03', 0, undefined, { currency: 'EUR', cents: 1000, rate: 1.5 })
    expect(lastRates(db)).toEqual({ USD: 1.38, EUR: 1.5 })
    const id = addTip(db, p, '2026-10-04', 5000)
    expect(queryTxns(db, p, {}).rows.find((r) => r.id === id)).toMatchObject({ amountCents: 5000, currency: null, originalCents: null, fxRate: null })
    expect(lastRates(db)).toEqual({ USD: 1.38, EUR: 1.5 }) // a home-currency tip does not touch the rates
  })

  it('refuses bad currencies, rates and amounts, and saves nothing', () => {
    const bad = (f: { currency: string; cents: number; rate: number }, re: RegExp) => expect(() => addTip(db, p, '2026-10-01', 0, undefined, f)).toThrow(re)
    bad({ currency: 'US', cents: 1000, rate: 1.3 }, /three letters/)
    bad({ currency: 'US$', cents: 1000, rate: 1.3 }, /three letters/)
    bad({ currency: 'CAD', cents: 1000, rate: 1 }, /home currency/)
    bad({ currency: 'USD', cents: 0, rate: 1.3 }, /greater than zero/)
    bad({ currency: 'USD', cents: 1000, rate: 0 }, /exchange rate/)
    bad({ currency: 'USD', cents: 1000, rate: -2 }, /exchange rate/)
    bad({ currency: 'USD', cents: 1000, rate: Number.NaN }, /exchange rate/)
    bad({ currency: 'USD', cents: 10.5, rate: 1.3 }, /greater than zero/)
    bad({ currency: 'JPY', cents: 1, rate: 0.0001 }, /less than one cent/)
    expect(queryTxns(db, p, {}).total).toBe(0)
    expect(lastRates(db)).toEqual({})
  })
})

describe('insights you can open', () => {
  const NOW = new Date(2026, 9, 25)
  const TODAY = '2026-10-25'

  it('every insight has a stable id, and most explain themselves and point somewhere', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', NOW)
    const pid = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const v = insightsFor(db, pid, undefined, TODAY)
    expect(v.insights.length).toBeGreaterThan(3)
    expect(new Set(v.insights.map((i) => i.id)).size).toBe(v.insights.length)
    expect(v.insights.every((i) => !!i.id)).toBe(true)
    expect(v.insights.filter((i) => i.meaning && i.ref).length).toBe(v.insights.length) // every one is explained and clickable
    expect(insightsFor(db, pid, undefined, TODAY).insights.map((i) => i.id)).toEqual(v.insights.map((i) => i.id)) // stable across calls
  })

  it('evidence for a category insight is that month\'s transactions in that category, largest first', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', NOW)
    const pid = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const v = insightsFor(db, pid, undefined, TODAY)
    const top = v.insights.find((i) => i.ref?.category && i.ref.page === 'transactions')!
    const ev = insightEvidence(db, pid, top.ref!, TODAY)
    expect(ev.kind).toBe('transactions')
    if (ev.kind !== 'transactions') return
    expect(ev.rows.length).toBeGreaterThan(0)
    expect(ev.rows.every((r) => r.category === top.ref!.category && r.date.startsWith(top.ref!.month!))).toBe(true)
    expect(ev.rows.map((r) => r.amountCents)).toEqual([...ev.rows.map((r) => r.amountCents)].sort((a, b) => a - b))
  })

  it('evidence for budgets and goals, and nothing for an unknown reference', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', NOW)
    const pid = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const budget = (db.prepare('SELECT name FROM budget WHERE profile_id = ? LIMIT 1').get(pid) as { name: string }).name
    expect(insightEvidence(db, pid, { page: 'budget', budget, month: '2026-09' }, TODAY)).toMatchObject({ kind: 'budget', line: { name: budget } })
    expect(insightEvidence(db, pid, { page: 'goals', goal: 'Emergency fund' }, TODAY)).toMatchObject({ kind: 'goal', goal: { name: 'Emergency fund' } })
    expect(insightEvidence(db, pid, { page: 'budget', budget: 'Nope' }, TODAY)).toEqual({ kind: 'none' })
    expect(insightEvidence(db, pid, { page: 'transactions', category: 'No such category', month: '2026-09' }, TODAY)).toEqual({ kind: 'none' })
    expect(insightEvidence(db, pid, { page: 'forecast' }, TODAY)).toEqual({ kind: 'none' })
  })

  it('a person never sees another person\'s evidence', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple', NOW)
    const [a, b] = (db.prepare("SELECT id FROM profile WHERE kind = 'person' ORDER BY id").all() as { id: number }[]).map((r) => r.id) as [number, number]
    const ev = insightEvidence(db, a, { page: 'transactions', category: 'Groceries', month: '2026-09' }, TODAY)
    const evB = insightEvidence(db, b, { page: 'transactions', category: 'Groceries', month: '2026-09' }, TODAY)
    if (ev.kind === 'transactions' && evB.kind === 'transactions') {
      const idsA = new Set(ev.rows.map((r) => r.id))
      expect(evB.rows.some((r) => idsA.has(r.id))).toBe(false)
      expect(ev.rows.every((r) => r.profileId === a)).toBe(true)
    }
  })
})

describe('the gentle banner tip', () => {
  const tip = (id: string, type: Insight['type'], tone: Insight['tone']): Insight => ({ id, type, tone, title: id })
  const all = [tip('fact-neutral', 'fact', 'neutral'), tip('good', 'fact', 'good'), tip('over', 'fact', 'warn'), tip('trend', 'trend', 'warn'), tip('unusual', 'anomaly', 'warn'), tip('rec', 'recommendation', 'warn')]

  it('puts something worth a look first (unusual, then trends, then recommendations), then good news, and never a bare neutral fact', () => {
    const order: string[] = []
    let skip: string[] = []
    for (;;) { const t = pickBannerTip(all, skip); if (!t) break; order.push(t.id!); skip = [...skip, t.id!] }
    expect(order).toEqual(['unusual', 'trend', 'rec', 'over', 'good'])
  })

  it('returns nothing when there is nothing to say', () => {
    expect(pickBannerTip([])).toBeNull()
    expect(pickBannerTip([tip('a', 'fact', 'neutral')])).toBeNull()
    expect(pickBannerTip(all, all.map((a) => a.id!))).toBeNull()
  })
})
