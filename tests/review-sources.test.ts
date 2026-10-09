import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { reviewTabOf } from '../src/core/reviewTabs'
import { reviewSummary, reviewNotice, reviewGroups, reviewGroupItems, resolveReview, resolveReviewGroup } from '../src/db/review'
import { listSourceRules, deleteSourceRule } from '../src/db/sourceRules'
import { buildPreview } from '../src/db/import'
import { setCategoryMany, queryTxns, getDashboard } from '../src/db/queries'
import type { ParsedStatement } from '../src/core/statement'

const TODAY = '2026-10-04'

describe('reviewTabOf', () => {
  it('sorts waiting rows into the four tabs', () => {
    expect(reviewTabOf({ amountCents: 5000, kind: 'unclassified', reason: 'E-transfer received: what was it for?', date: '2026-09-01' }, TODAY)).toBe('possible_income')
    expect(reviewTabOf({ amountCents: 5000, kind: 'income', reason: 'Needs a category', date: '2026-09-01' }, TODAY)).toBe('money_in')
    expect(reviewTabOf({ amountCents: -5000, kind: 'unclassified', reason: 'E-transfer sent: what was it for?', date: '2026-09-01' }, TODAY)).toBe('money_out')
    expect(reviewTabOf({ amountCents: -5000, kind: 'expense', reason: 'Needs a category', date: '2026-09-01' }, TODAY)).toBe('money_out')
    expect(reviewTabOf({ amountCents: -5000, kind: 'unclassified', reason: 'Money moved to or from an investment or another account: which one?', date: '2026-09-01' }, TODAY)).toBe('other')
    expect(reviewTabOf({ amountCents: 5000, kind: 'unclassified', reason: 'Transfer with no destination shown: where?', date: '2026-09-01' }, TODAY)).toBe('other')
  })
})

describe('review by source', () => {
  let db: Db
  let p: number, chq: number, gifts: number, food: number
  let n = 0
  const add = (date: string, cents: number, raw: string, reason: string | null = 'x', kind = 'unclassified') =>
    Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, review_reason, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(p, chq, date, cents, raw, raw, kind, reason, `s${n++}`).lastInsertRowid)
  const IN = 'INTERNET BANKING E-TRANSFER 105217883291 SAM LEE'
  const OUT = 'INTERNET BANKING E-TRANSFER 105217883292 SAM LEE'

  beforeEach(() => {
    db = openDb(':memory:')
    ;[p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }] }]) as [number]
    chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
    gifts = Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?, 'Gifts X', 'income')").run(p).lastInsertRowid)
    food = Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?, 'Food X', 'expense')").run(p).lastInsertRowid)
  })

  it('counts each tab and groups a tab by source, biggest group first', () => {
    for (let i = 1; i <= 3; i++) add(`2026-09-0${i}`, 2000, IN, 'E-transfer received: what was it for?')
    add('2026-09-05', 1000, 'INTERNET BANKING E-TRANSFER 105217883299 JO KIM', 'E-transfer received: what was it for?')
    add('2026-09-06', -4000, OUT, 'E-transfer sent: what was it for?')
    const s = reviewSummary(db, p, TODAY)
    expect(s.total).toBe(5)
    expect(s.tabs.map((t) => [t.tab, t.count])).toEqual([['possible_income', 4], ['money_in', 0], ['money_out', 1], ['other', 0], ['older', 0]])
    const g = reviewGroups(db, p, 'possible_income', TODAY)
    expect(g.total).toBe(2)
    expect(g.groups.map((x) => [x.name, x.count, x.totalCents])).toEqual([['Sam Lee', 3, 6000], ['Jo Kim', 1, 1000]])
    expect(reviewGroups(db, p, 'possible_income', TODAY, 1, 1).groups.map((x) => x.name)).toEqual(['Jo Kim'])
  })

  it('pages the transactions of one source', () => {
    for (let i = 1; i <= 5; i++) add(`2026-09-0${i}`, 2000, IN, 'E-transfer received: what was it for?')
    const r = reviewGroupItems(db, p, 'possible_income', TODAY, '+SAM LEE', 0, 2)
    expect(r.total).toBe(5)
    expect(r.items.map((x) => x.date)).toEqual(['2026-09-05', '2026-09-04'])
    expect(reviewGroupItems(db, p, 'possible_income', TODAY, '+SAM LEE', 4, 2).items).toHaveLength(1)
  })

  it('one decision files a whole source; remembering also files later ones and future imports, in that direction only', () => {
    for (let i = 1; i <= 3; i++) add(`2026-09-0${i}`, 2000, IN, 'E-transfer received: what was it for?')
    const sent = add('2026-09-09', -4000, OUT, 'E-transfer sent: what was it for?')
    const r = resolveReviewGroup(db, p, 'possible_income', TODAY, '+SAM LEE', { kind: 'income', categoryId: gifts }, { remember: true })
    expect(r.resolved).toBe(3)
    expect(queryTxns(db, p, { categoryId: gifts }).total).toBe(3)
    // money going OUT to the same person is a different decision and is still waiting
    expect((db.prepare('SELECT review_reason r FROM txn WHERE id = ?').get(sent) as { r: string | null }).r).not.toBeNull()
    expect(listSourceRules(db, p).map((x) => [x.name, x.direction, x.kind, x.categoryName])).toEqual([['Sam Lee', 'in', 'income', 'Gifts X']])

    // a later import: the same person sending money is filed without asking; sending the other way still asks
    const parsed: ParsedStatement = { format: 'headered', warnings: [], rows: [
      { line: 2, date: '2026-10-02', description: 'INTERNET BANKING E-TRANSFER 105217883555 SAM LEE', amountCents: 2500 },
      { line: 3, date: '2026-10-03', description: 'INTERNET BANKING E-TRANSFER 105217883556 SAM LEE', amountCents: -1500 }
    ] }
    const pv = buildPreview(db, p, chq, parsed, 'oct.csv')
    expect(pv.rows[0]).toMatchObject({ kind: 'income', categoryId: gifts, reviewReason: null })
    expect(pv.rows[1]).toMatchObject({ kind: 'unclassified' })
    expect(pv.rows[1]!.reviewReason).toBeTruthy()
  })

  it('remembering applies to everything already waiting from that source', () => {
    const a = add('2026-09-01', 2000, IN, 'E-transfer received: what was it for?')
    add('2026-09-02', 2000, IN, 'E-transfer received: what was it for?')
    add('2026-09-03', 2000, IN, 'E-transfer received: what was it for?')
    const r = resolveReview(db, a, { kind: 'income', categoryId: gifts }, { remember: true })
    expect(r.alsoResolved).toBe(2)
    expect(reviewSummary(db, p, TODAY).total).toBe(0)
  })

  it('without the tick nothing is remembered', () => {
    add('2026-09-01', 2000, IN, 'E-transfer received: what was it for?')
    const b = add('2026-09-02', 2000, IN, 'E-transfer received: what was it for?')
    resolveReviewGroup(db, p, 'possible_income', TODAY, '+SAM LEE', { kind: 'income', categoryId: gifts })
    expect(listSourceRules(db, p)).toEqual([])
    const c = add('2026-09-03', 2000, IN, 'E-transfer received: what was it for?')
    const pv = buildPreview(db, p, chq, { format: 'headered', warnings: [], rows: [{ line: 2, date: '2026-10-02', description: IN, amountCents: 2500 }] }, 'x.csv')
    expect(pv.rows[0]!.kind).toBe('unclassified')
    expect(b).toBeGreaterThan(0); expect(c).toBeGreaterThan(0)
  })

  it('a remembered source can be forgotten; past transactions stay as they are', () => {
    const a = add('2026-09-01', 2000, IN, 'E-transfer received: what was it for?')
    resolveReview(db, a, { kind: 'income', categoryId: gifts }, { remember: true })
    const [rule] = listSourceRules(db, p)
    deleteSourceRule(db, p, rule!.id)
    expect(listSourceRules(db, p)).toEqual([])
    expect(queryTxns(db, p, { categoryId: gifts }).total).toBe(1)
    expect(() => deleteSourceRule(db, p, rule!.id)).toThrow(/no longer exists/)
  })

  it('waiting transactions older than 90 days are set aside in their own tab, not counted as recent', () => {
    add('2026-09-20', 2000, IN, 'E-transfer received: what was it for?')
    for (let i = 0; i < 4; i++) add(`2024-03-0${i + 1}`, -1500, OUT, 'E-transfer sent: what was it for?')
    add('2026-07-06', 700, 'INTERNET BANKING E-TRANSFER 105217883777 JO KIM', 'E-transfer received: what was it for?') // 90 days before 2026-10-04: still recent
    add('2026-07-05', 700, 'INTERNET BANKING E-TRANSFER 105217883778 JO KIM', 'E-transfer received: what was it for?') // 91 days: older
    const s = reviewSummary(db, p, TODAY)
    expect(s).toMatchObject({ total: 7, recent: 2, older: 5 })
    expect(s.tabs.map((t) => [t.tab, t.count])).toEqual([['possible_income', 2], ['money_in', 0], ['money_out', 0], ['other', 0], ['older', 5]])
    expect(reviewGroups(db, p, 'older', TODAY).groups.map((g) => [g.name, g.count])).toEqual([['Sam Lee', 4], ['Jo Kim', 1]])
    expect(reviewNotice(db, p, TODAY)).toEqual({ recent: 2, older: 5, days: 90 })
    expect(reviewNotice(db, null, TODAY)).toEqual({ recent: 2, older: 5, days: 90 })
    add('2026-09-02', -100, 'COFFEE', null, 'expense')
    expect(getDashboard(db, p, undefined, TODAY)!.reviewCount).toBe(2) // the dashboard banner counts recent ones only
  })

  it('older ones can still be decided for a whole source, and remembered', () => {
    for (let i = 0; i < 3; i++) add(`2023-05-0${i + 1}`, 1000, IN, 'E-transfer received: what was it for?')
    resolveReviewGroup(db, p, 'older', TODAY, '+SAM LEE', { kind: 'income', categoryId: gifts }, { remember: true })
    expect(reviewSummary(db, p, TODAY).total).toBe(0)
    expect(listSourceRules(db, p)).toHaveLength(1)
  })

  it('a rule needs a direction that fits the decision', () => {
    const a = add('2026-09-01', -2000, OUT, 'E-transfer sent: what was it for?')
    expect(() => resolveReview(db, a, { kind: 'income', categoryId: gifts }, { remember: true })).toThrow(/money coming in/)
  })
})

describe('moving many transactions to a category', () => {
  it('moves the selection, checks every row first, and only remembers when asked', () => {
    const db = openDb(':memory:')
    const [p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }] }]) as [number]
    const chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
    const cat = (name: string, kind: string) => Number(db.prepare('INSERT INTO category (profile_id, name, kind) VALUES (?,?,?)').run(p, name, kind).lastInsertRowid)
    const a = cat('Cat A', 'expense'), b = cat('Cat B', 'expense'), inc = cat('Inc A', 'income')
    let n = 0
    const add = (cents: number, text: string, kind: string, c: number | null) => Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,'2026-09-01',?,?,?,?,?,'import',?)").run(p, chq, cents, text, text, kind, c, `m${n++}`).lastInsertRowid)
    const t1 = add(-1000, 'SHOP ONE', 'expense', a), t2 = add(-2000, 'SHOP TWO', 'expense', a), pay = add(5000, 'PAYROLL', 'income', inc), xf = add(-500, 'MOVE', 'transfer', null)

    expect(() => setCategoryMany(db, [], b)).toThrow(/Select at least one/)
    expect(() => setCategoryMany(db, [t1, pay], b)).toThrow(/mixes income and spending/)
    expect(() => setCategoryMany(db, [t1, xf], b)).toThrow(/Only income, expense and refund/)
    expect((db.prepare('SELECT category_id c FROM txn WHERE id = ?').get(t1) as { c: number }).c).toBe(a) // nothing changed by the failed attempts

    expect(setCategoryMany(db, [t1, t2], b)).toEqual({ updated: 2, remembered: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM category_rule WHERE source = ?').get('user')).toEqual({ n: 0 })
    expect(setCategoryMany(db, [t1, t2], a, true)).toEqual({ updated: 2, remembered: 2 })
    expect(db.prepare('SELECT COUNT(*) n FROM category_rule WHERE source = ?').get('user')).toEqual({ n: 2 })
  })

  it('the spending filter combines expenses and refunds', () => {
    const db = openDb(':memory:')
    const [p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }] }]) as [number]
    const chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
    let n = 0
    for (const [k, c] of [['income', 5000], ['expense', -1000], ['refund', 300], ['transfer', -50]] as const) db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,'2026-09-01',?,?,?,'import',?)").run(p, chq, c, k, k, `f${n++}`)
    expect(queryTxns(db, p, { kind: 'expense,refund' }).rows.map((r) => r.kind).sort()).toEqual(['expense', 'refund'])
    expect(queryTxns(db, p, { kind: 'income,expense,refund' }).total).toBe(3)
    expect(queryTxns(db, p, { kind: 'income' }).total).toBe(1)
  })
})
