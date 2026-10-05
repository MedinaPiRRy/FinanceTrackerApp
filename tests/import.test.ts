import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { buildPreview, commitImport, listImports, undoImport, type CommitRow, type Preview } from '../src/db/import'
import { parseStatement } from '../src/core/statement'
import { readStatementRows } from '../src/importers/statementFile'
import { listReviewQueue } from '../src/db/review'

let db: Db
let p: number, p2: number, chq: number, card: number, inv: number
let dining: number, transport: number, income: number, otherDining: number
let n = 0

const hist = (account: number, date: string, cents: number, desc: string, kind: string, cat: number | null, raw: string | null = null) =>
  db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, category_id, kind, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'manual',?)`).run(p, account, date, cents, desc, raw, cat, kind, `h${n++}`)

const cardCsv = (lines: string[]) => parseStatement(lines.map((l) => l.split('|')))
const toCommit = (pv: Preview): CommitRow[] => pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('alex','Alex')").run().lastInsertRowid)
  p2 = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('sam','Sam')").run().lastInsertRowid)
  const acct = (pid: number, name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(pid, name, type).lastInsertRowid)
  chq = acct(p, 'Chequing', 'chequing'); card = acct(p, 'Visa', 'credit_card'); inv = acct(p, 'Home fund', 'investment')
  const cat = (pid: number, name: string, kind: string) => Number(db.prepare('INSERT INTO category (profile_id,name,kind) VALUES (?,?,?)').run(pid, name, kind).lastInsertRowid)
  dining = cat(p, 'Fast Food & Dining', 'expense'); transport = cat(p, 'Gas & Transportation', 'expense'); income = cat(p, 'Pay', 'income'); otherDining = cat(p2, 'Dining', 'expense')
  // history: this person's own past rows (clean names)
  hist(card, '2026-01-05', -1200, "McDonald's", 'expense', dining)
  hist(card, '2026-01-06', -1500, "McDonald's", 'expense', dining)
  hist(card, '2026-01-07', -4000, 'Petro-Canada', 'expense', transport)
})

const CARD_LINES = [
  "2026-09-25|MCDONALD'S #40732 MILTON, ON|8.92||4000********4879",
  '2026-09-24|PETRO-CANADA 35288 MILTON, ON|45.10||4000********4879',
  '2026-09-23|ZZ UNKNOWN SHOP TORONTO, ON|19.99||4000********4879',
  '2026-09-22|PAYMENT THANK YOU/PAIEMEN T MERCI||300.00|4000********4879'
]

describe('preview', () => {
  it('categorises from your history, defers unknowns to review, and marks card payments as transfers', () => {
    const pv = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    const by = (s: string) => pv.rows.find((r) => r.raw.includes(s))!
    expect(by('MCDONALD')).toMatchObject({ kind: 'expense', categoryId: dining, description: "McDonald's", suggestionSource: 'history', status: 'new', include: true })
    expect(by('PETRO')).toMatchObject({ categoryId: transport, description: 'Petro-Canada' })
    expect(by('UNKNOWN')).toMatchObject({ kind: 'expense', categoryId: null, reviewReason: 'Needs a category' })
    expect(by('PAYMENT')).toMatchObject({ kind: 'transfer', reviewReason: null })
    expect(pv.summary).toMatchObject({ total: 4, newCount: 4, duplicateCount: 0, needsReviewCount: 1, minDate: '2026-09-22', maxDate: '2026-09-25' })
  })
  it('falls back to built-in keywords mapped to your own category names', () => {
    const pv = buildPreview(db, p, card, cardCsv(['2026-09-20|WENDY\'S #99 TORONTO, ON|7.00||x']), 'x.csv')
    expect(pv.rows[0]).toMatchObject({ categoryId: dining, suggestionSource: 'builtin' })
  })
  it('never auto-categorises e-transfers: they wait for the user', () => {
    const pv = buildPreview(db, p, chq, parseStatement([['2026-09-22', 'Internet Banking E-TRANSFER 900000000003 Pat Kim', '30.00', '']]), 'c.csv')
    expect(pv.rows[0]).toMatchObject({ kind: 'unclassified', categoryId: null, description: 'E-Transfer to Pat Kim' })
    expect(pv.rows[0]!.reviewReason).toMatch(/E-transfer sent/)
  })
  it('detects rows the app already has (same account, date and amount), one per existing row', () => {
    hist(card, '2026-09-25', -892, "McDonald's", 'expense', dining)
    hist(chq, '2026-09-24', -4510, 'Petro-Canada', 'expense', transport) // other account: must NOT count
    const pv = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    expect(pv.rows.filter((r) => r.status === 'duplicate').map((r) => r.date)).toEqual(['2026-09-25'])
    expect(pv.rows.find((r) => r.status === 'duplicate')).toMatchObject({ include: false, matchedDescription: "McDonald's" })
  })
  it('treats two identical purchases as two rows when the app has only one of them', () => {
    hist(card, '2026-09-25', -892, "McDonald's", 'expense', dining)
    const pv = buildPreview(db, p, card, cardCsv(["2026-09-25|MCDONALD'S #1 X, ON|8.92||x", "2026-09-25|MCDONALD'S #2 X, ON|8.92||x"]), 'x.csv')
    expect(pv.rows.map((r) => r.status)).toEqual(['duplicate', 'new'])
  })
  it("refuses another person's account and investment accounts", () => {
    const theirs = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(p2).lastInsertRowid)
    expect(() => buildPreview(db, p, theirs, cardCsv(CARD_LINES), 'x')).toThrow(/your own accounts/)
    expect(() => buildPreview(db, p, inv, cardCsv(CARD_LINES), 'x')).toThrow(/valued by hand/)
  })
})

describe('duplicates inside one file and near-duplicates', () => {
  const LINE = "2026-10-02|MCDONALD'S #40732 MILTON, ON|8.92||x"
  it('holds back a second identical line (same date, amount and bank text) until the user confirms it', () => {
    const pv = buildPreview(db, p, card, cardCsv([LINE, LINE, '2026-10-02|TIM HORTONS #1 X, ON|3.00||x']), 'x.csv')
    expect(pv.rows.map((r) => r.status)).toEqual(['new', 'repeat', 'new'])
    expect(pv.rows[1]).toMatchObject({ include: false })
    expect(pv.summary).toMatchObject({ newCount: 2, repeatCount: 1, duplicateCount: 0 })
    // default import saves only one copy
    const res = commitImport(db, p, card, 'x.csv', toCommit(pv), { learnFromDuplicates: false })
    expect(res.inserted).toBe(2)
  })
  it('a confirmed real second purchase is saved too, and re-importing the file then adds nothing', () => {
    const pv = buildPreview(db, p, card, cardCsv([LINE, LINE]), 'x.csv')
    const both = toCommit(pv).map((r) => ({ ...r, include: true }))
    expect(commitImport(db, p, card, 'x.csv', both, { learnFromDuplicates: false }).inserted).toBe(2)
    const again = buildPreview(db, p, card, cardCsv([LINE, LINE]), 'x.csv')
    expect(again.rows.map((r) => r.status)).toEqual(['duplicate', 'duplicate'])
    expect(again.summary.newCount).toBe(0)
  })
  it('the same line in the file and once in the app: the first copy is the app one, the second is held back', () => {
    hist(card, '2026-10-02', -892, "McDonald's", 'expense', dining)
    const pv = buildPreview(db, p, card, cardCsv([LINE, LINE]), 'x.csv')
    expect(pv.rows.map((r) => r.status)).toEqual(['duplicate', 'repeat'])
  })
  it('hints at a similar row a day or two away, without excluding it', () => {
    hist(card, '2026-10-01', -892, "McDonald's", 'expense', dining) // recorded a day earlier than the bank posted it
    const pv = buildPreview(db, p, card, cardCsv([LINE]), 'x.csv')
    expect(pv.rows[0]).toMatchObject({ status: 'new', include: true, nearMatch: { date: '2026-10-01', description: "McDonald's" } })
    expect(pv.summary.nearMatchCount).toBe(1)
  })
  it('does not hint when the name or amount differs, or the gap is more than three days', () => {
    hist(card, '2026-10-01', -999, "McDonald's", 'expense', dining) // other amount
    hist(card, '2026-09-20', -892, "McDonald's", 'expense', dining) // too far
    hist(card, '2026-10-01', -892, 'Petro-Canada', 'expense', transport) // other merchant
    expect(buildPreview(db, p, card, cardCsv([LINE]), 'x.csv').rows[0]!.nearMatch).toBeNull()
  })
})

describe('commit', () => {
  it('saves included rows, keeps the raw bank text, queues what needs a decision, and is traceable to a batch', () => {
    const pv = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    const r = commitImport(db, p, card, 'sep.csv', toCommit(pv), { learnFromDuplicates: false })
    expect(r).toMatchObject({ inserted: 4, skippedExisting: 0, queuedForReview: 1 })
    const row = db.prepare("SELECT description, description_raw raw, source, import_batch_id b FROM txn WHERE description_raw LIKE 'MCDONALD%'").get() as { description: string; raw: string; source: string; b: number }
    expect(row).toMatchObject({ description: "McDonald's", source: 'import', b: r.batchId })
    expect(listReviewQueue(db, p).map((q) => q.reason)).toEqual(['Needs a category'])
  })
  it('importing the same file twice adds nothing the second time', () => {
    const first = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    commitImport(db, p, card, 'sep.csv', toCommit(first), { learnFromDuplicates: false })
    const again = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    expect(again.summary.duplicateCount).toBe(4)
    // even if the user forces every row in, the fingerprint guard stops true repeats
    const forced = toCommit(again).map((r) => ({ ...r, include: true }))
    const r = commitImport(db, p, card, 'sep.csv', forced, { learnFromDuplicates: false })
    expect(r.inserted).toBe(0)
    expect(r.skippedExisting).toBe(4)
  })
  it('remembers a correction: next import categorises that merchant automatically', () => {
    const pv = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    const rows = toCommit(pv).map((r) => (r.raw.includes('UNKNOWN') ? { ...r, categoryId: transport, description: 'Zed Shop' } : r))
    const res = commitImport(db, p, card, 'sep.csv', rows, { learnFromDuplicates: false })
    expect(res.learned).toBe(1)
    expect(listReviewQueue(db, p)).toHaveLength(0) // choosing a category cleared "Needs a category"
    const next = buildPreview(db, p, card, cardCsv(['2026-10-02|ZZ UNKNOWN SHOP OAKVILLE, ON|5.00||x']), 'oct.csv')
    expect(next.rows[0]).toMatchObject({ categoryId: transport, description: 'Zed Shop', suggestionSource: 'user' })
  })
  it("a user's correction beats history", () => {
    const pv = buildPreview(db, p, card, cardCsv(["2026-09-25|MCDONALD'S #1 X, ON|8.92||x"]), 'x.csv')
    commitImport(db, p, card, 'x.csv', toCommit(pv).map((r) => ({ ...r, categoryId: transport })), { learnFromDuplicates: false })
    const next = buildPreview(db, p, card, cardCsv(["2026-10-01|MCDONALD'S #2 X, ON|9.00||x"]), 'y.csv')
    expect(next.rows[0]).toMatchObject({ categoryId: transport, suggestionSource: 'user' })
  })
  it('learns merchant names and categories from rows the app already has (re-importing a statement the app already has)', () => {
    hist(card, '2026-09-22', -1468, 'YouTube Premium', 'expense', dining) // clean name only, no raw text yet
    const csv = cardCsv(['2026-09-22|GOOGLE*YOUTUBEPREMIUM HALIFAX, NS|14.68||x'])
    const pv = buildPreview(db, p, card, csv, 'old.csv')
    expect(pv.rows[0]).toMatchObject({ status: 'duplicate', matchedDescription: 'YouTube Premium' })
    const res = commitImport(db, p, card, 'old.csv', toCommit(pv), { learnFromDuplicates: true })
    expect(res).toMatchObject({ inserted: 0, learned: 1 })
    expect((db.prepare("SELECT description_raw r FROM txn WHERE description='YouTube Premium'").get() as { r: string }).r).toBe('GOOGLE*YOUTUBEPREMIUM HALIFAX, NS')
    const next = buildPreview(db, p, card, cardCsv(['2026-10-10|GOOGLE *YOUTUBEPREMIUM g.co/helppay#, NS|14.68||x']), 'new.csv')
    expect(next.rows[0]).toMatchObject({ description: 'YouTube Premium', categoryId: dining, suggestionSource: 'alias' })
  })
  it('rejects rows that would flip the meaning of money, or use the wrong profile or kind of category', () => {
    const pv = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    const rows = toCommit(pv)
    expect(() => commitImport(db, p, card, 'x', rows.map((r) => (r.raw.includes('PETRO') ? { ...r, kind: 'income' as const } : r)), { learnFromDuplicates: false })).toThrow(/income must be money coming in/)
    expect(() => commitImport(db, p, card, 'x', rows.map((r) => (r.raw.includes('PETRO') ? { ...r, categoryId: otherDining } : r)), { learnFromDuplicates: false })).toThrow(/another person/)
    expect(() => commitImport(db, p, card, 'x', rows.map((r) => (r.raw.includes('PETRO') ? { ...r, categoryId: income } : r)), { learnFromDuplicates: false })).toThrow(/needs a expense category/)
    expect((db.prepare("SELECT COUNT(*) n FROM txn WHERE source='import'").get() as { n: number }).n).toBe(0) // all-or-nothing
  })
  it('links a chequing "payment to card" with the card\'s "payment received"', () => {
    const c1 = buildPreview(db, p, card, cardCsv(['2026-09-22|PAYMENT THANK YOU/PAIEMEN T MERCI||300.00|x']), 'card.csv')
    commitImport(db, p, card, 'card.csv', toCommit(c1), { learnFromDuplicates: false })
    const c2 = buildPreview(db, p, chq, parseStatement([['2026-09-21', 'Internet Banking INTERNET TRANSFER 900000000004 TO CARD 4000********0180', '300.00', '']]), 'chq.csv')
    const res = commitImport(db, p, chq, 'chq.csv', toCommit(c2), { learnFromDuplicates: false })
    expect(res.transfersPaired).toBe(1)
    expect((db.prepare("SELECT SUM(amount_cents) s FROM txn WHERE transfer_group IS NOT NULL").get() as { s: number }).s).toBe(0)
  })
})

describe('undo', () => {
  it('removes exactly what that import added, and refuses a batch the importer did not create', () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n
    const pv = buildPreview(db, p, card, cardCsv(CARD_LINES), 'sep.csv')
    const { batchId } = commitImport(db, p, card, 'sep.csv', toCommit(pv), { learnFromDuplicates: false })
    expect(listImports(db, p)[0]).toMatchObject({ id: batchId, rowCount: 4, remaining: 4, undoable: true })
    expect(undoImport(db, p, batchId)).toBe(4)
    expect((db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n).toBe(before)
    const wb = Number(db.prepare("INSERT INTO import_batch (profile_id, source, filename) VALUES (?, 'other', 'other.csv')").run(p).lastInsertRowid)
    expect(() => undoImport(db, p, wb)).toThrow(/Only statement imports/)
    expect(() => undoImport(db, p2, wb)).toThrow(/no longer exists/)
  })
})

describe('statement files', () => {
  it('reads CSV text from memory, with a BOM and quoted commas', () => {
    const csv = '﻿2026-09-25,"MCDONALD\'S #40732 MILTON, ON",8.92,,4000********4879\n'
    expect(readStatementRows('s.csv', new TextEncoder().encode(csv))[0]).toEqual(['2026-09-25', "MCDONALD'S #40732 MILTON, ON", '8.92', '', '4000********4879'])
  })
  it('explains unsupported and oversized files', () => {
    expect(() => readStatementRows('s.pdf', new Uint8Array(10))).toThrow(/PDF statements are not supported/)
    expect(() => readStatementRows('s.docx', new Uint8Array(10))).toThrow(/Unsupported/)
    expect(() => readStatementRows('s.csv', new Uint8Array(6 * 1024 * 1024))).toThrow(/larger than 5 MB/)
  })
})

describe('remembering corrections everywhere', () => {
  it('fixing a category in the transactions table teaches the app (but not for e-transfers)', async () => {
    const { setTxnCategory } = await import('../src/db/queries')
    const pv = buildPreview(db, p, card, cardCsv(['2026-09-23|ZZ UNKNOWN SHOP TORONTO, ON|19.99||x']), 'a.csv')
    commitImport(db, p, card, 'a.csv', toCommit(pv), { learnFromDuplicates: false })
    const t = db.prepare("SELECT id FROM txn WHERE description_raw LIKE 'ZZ UNKNOWN%'").get() as { id: number }
    setTxnCategory(db, t.id, transport)
    const next = buildPreview(db, p, card, cardCsv(['2026-10-23|ZZ UNKNOWN SHOP OAKVILLE, ON|5.00||x']), 'b.csv')
    expect(next.rows[0]).toMatchObject({ categoryId: transport, suggestionSource: 'user' })

    // an e-transfer correction must NOT become a rule
    const ev = buildPreview(db, p, chq, parseStatement([['2026-09-22', 'Internet Banking E-TRANSFER 900000000003 Pat Kim', '30.00', '']]), 'e.csv')
    commitImport(db, p, chq, 'e.csv', toCommit(ev), { learnFromDuplicates: false })
    const e = db.prepare("SELECT id FROM txn WHERE description_raw LIKE '%Pat Kim%'").get() as { id: number }
    const { resolveReview } = await import('../src/db/review')
    resolveReview(db, e.id, { kind: 'expense', categoryId: dining })
    expect((db.prepare("SELECT COUNT(*) n FROM category_rule WHERE pattern LIKE '%PAT%'").get() as { n: number }).n).toBe(0)
  })
  it('resolving a review item with a category teaches the app too', async () => {
    const { resolveReview } = await import('../src/db/review')
    const pv = buildPreview(db, p, card, cardCsv(['2026-09-23|ZZ UNKNOWN SHOP TORONTO, ON|19.99||x']), 'a.csv')
    commitImport(db, p, card, 'a.csv', toCommit(pv), { learnFromDuplicates: false })
    const q = listReviewQueue(db, p)[0]!
    resolveReview(db, q.id, { kind: 'expense', categoryId: dining })
    const next = buildPreview(db, p, card, cardCsv(['2026-10-23|ZZ UNKNOWN SHOP OAKVILLE, ON|5.00||x']), 'b.csv')
    expect(next.rows[0]).toMatchObject({ categoryId: dining, suggestionSource: 'user' })
  })
})
