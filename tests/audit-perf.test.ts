// Audit: speed on a large database (100,000 transactions over five years). Prints a timing table; fails only if something is far too slow.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type Db } from '../src/db/open'
import { createHandlers } from '../src/main/handlers'
import { buildPreview, commitImport, type CommitRow } from '../src/db/import'
import { parseStatement } from '../src/core/statement'

const N = Number(process.env.AUDIT_ROWS ?? (process.env.CI ? 30_000 : 100_000)) // lighter on shared build machines
let dir: string, file: string, h: Record<string, (...a: unknown[]) => unknown>, p: number, p2: number, chq: number
const timings: { op: string; ms: number }[] = []
const time = async <T,>(op: string, fn: () => T | Promise<T>): Promise<T> => { const t = performance.now(); const r = await fn(); timings.push({ op, ms: Math.round(performance.now() - t) }); return r }

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-perf-'))
  file = path.join(dir, 'finance.db')
  const db = openDb(file)
  const prof = (slug: string, name: string) => Number(db.prepare('INSERT INTO profile (slug, name) VALUES (?, ?)').run(slug, name).lastInsertRowid)
  p = prof('daniel', 'Daniel'); p2 = prof('babytas', 'Babytas')
  const accts: number[] = []
  const cats: { exp: number[]; inc: number } = { exp: [], inc: 0 }
  for (const pid of [p, p2]) {
    const a = (name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id, name, type) VALUES (?,?,?)').run(pid, name, type).lastInsertRowid)
    const c = a('Chequing', 'chequing'); a('Visa', 'credit_card'); a('Savings', 'savings'); a('Cash', 'cash')
    if (pid === p) { chq = c; accts.push(c, c + 1) }
    const ce = ['Food', 'Dining', 'Transport', 'Shopping', 'Bills', 'Fun', 'Health', 'Travel', 'Gifts', 'Other'].map((n) => Number(db.prepare('INSERT INTO category (profile_id, name, kind) VALUES (?,?,?)').run(pid, n, 'expense').lastInsertRowid))
    const ci = Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?, 'Pay', 'income')").run(pid).lastInsertRowid)
    if (pid === p) { cats.exp = ce; cats.inc = ci }
  }
  const ins = db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, review_reason, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,'import',?)")
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const d = new Date(Date.UTC(2022, 0, 1) + Math.floor(rnd() * 5 * 365) * 86_400_000).toISOString().slice(0, 10)
      const isIncome = rnd() < 0.04
      const merchant = `MERCHANT ${Math.floor(rnd() * 800)} MILTON ON`
      const review = rnd() < 0.03
      ins.run(p, accts[i % 2]!, d, isIncome ? 150000 + Math.floor(rnd() * 100000) : -Math.floor(200 + rnd() * 20000), merchant, merchant, isIncome ? 'income' : 'expense', review ? null : isIncome ? cats.inc : cats.exp[Math.floor(rnd() * 10)]!, review ? 'Needs a category' : null, `p${i}`)
    }
  })()
  db.close()
}, 600_000)

afterAll(() => { try { h.close!() } catch { /* */ } console.log('\nAUDIT-PERF rows=' + N + '\n' + timings.map((t) => `${t.op.padEnd(44)} ${String(t.ms).padStart(7)} ms`).join('\n')); fs.rmSync(dir, { recursive: true, force: true }) })

describe(`large database (${N.toLocaleString()} rows)`, () => {
  it('measures the main screens', async () => {
    process.env.FINANCE_WORKBOOK_DIR = dir
    h = createHandlers(file) as unknown as typeof h
    await time('open + status', () => h.status!())
    await time('dashboard (latest month)', () => h.dashboard!(p))
    await time('dashboard (2023-06)', () => h.dashboard!(p, '2023-06'))
    await time('transactions page 1 (50 rows)', () => h.txns!(p, { limit: 50, offset: 0 }))
    await time('transactions page 1000 (offset 49950)', () => h.txns!(p, { limit: 50, offset: 49_950 }))
    await time('transactions, search text', () => h.txns!(p, { text: 'MERCHANT 77', limit: 50 }))
    await time('transactions, one category', () => h.txns!(p, { categoryId: 1, limit: 50 }))
    await time('transactions, sort by amount', () => h.txns!(p, { sort: 'amount', limit: 50 }))
    await time('transactions, sort by category', () => h.txns!(p, { sort: 'category', limit: 50 }))
    await time('select all that match (txnIds, 5000)', () => h.txnIds!(p, {}))
    await time('review summary', () => h.reviewSummary!(p))
    await time('review groups (money out)', () => h.reviewGroups!(p, 'money_out', 0, 50))
    await time('monthly review', () => h.monthlyReview!(p))
    await time('insights', () => h.insights!(p))
    await time('budgets', () => h.budgets!(p, '2026-06'))
    await time('goals', () => h.goals!(p))
    await time('forecast (24 months)', () => h.forecast!(p, 24))
    await time('forecast (60 months)', () => h.forecast!(p, 60))
    await time('recurring suggestions', () => h.recurringSuggest!(p))
    await time('taxes and interest (year)', () => h.costsReport!(p, 2025))
    await time('net worth', () => h.netWorth!(p))
    await time('category manager list', () => h.categoryManage!(p))
    await time('duplicate accounts check', () => h.duplicatesFind!(p))
    await time('household overview', () => h.householdOverview!())
    await time('export all to CSV (build only)', () => h.exportCsv!(p))
    await time('backup (VACUUM INTO)', () => h.backupNow!())

    // an import of 3,800 lines against all that history
    const db = openDb(file)
    const lines = Array.from({ length: 3800 }, (_, i) => [new Date(Date.UTC(2026, 5, 1) + (i % 28) * 86_400_000).toISOString().slice(0, 10), `MERCHANT ${i % 800} MILTON ON`, (5 + (i % 90)).toFixed(2), ''])
    const pv = await time('import preview, 3,800 lines', () => buildPreview(db, p, chq, parseStatement(lines), 'big.csv'))
    const rows = pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r) as CommitRow[]
    await time('import commit, 3,800 lines', () => commitImport(db, p, chq, 'big.csv', rows, { learnFromDuplicates: false }))
    db.close()
    // generous ceilings: the point is to catch a screen that takes many seconds
    for (const t of timings) expect(t.ms, t.op).toBeLessThan(15_000)
  }, 900_000)

  it('the main queries use an index', () => {
    const db: Db = openDb(file)
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(' | ')
    const out: Record<string, string> = {
      'list by profile and date': plan('SELECT * FROM txn WHERE profile_id = ? AND posted_date BETWEEN ? AND ? ORDER BY posted_date DESC LIMIT 50', p, '2026-01-01', '2026-01-31'),
      'filter by category': plan('SELECT * FROM txn WHERE profile_id = ? AND category_id = ? LIMIT 50', p, 1),
      'filter by account and date': plan('SELECT * FROM txn WHERE account_id = ? AND posted_date >= ? LIMIT 50', chq, '2026-01-01'),
      'review queue': plan('SELECT * FROM txn WHERE profile_id = ? AND review_reason IS NOT NULL', p),
      'fingerprint lookup (import dedupe)': plan('SELECT 1 FROM txn WHERE profile_id = ? AND fingerprint = ?', p, 'x'),
      'text search': plan("SELECT * FROM txn WHERE profile_id = ? AND description LIKE '%abc%' LIMIT 50", p),
      'sum by account': plan('SELECT SUM(amount_cents) FROM txn WHERE account_id = ?', chq),
      'transfer group': plan('SELECT * FROM txn WHERE transfer_group = ?', 'g'),
      'kind and date': plan("SELECT SUM(amount_cents) FROM txn WHERE profile_id = ? AND kind = 'expense' AND posted_date BETWEEN ? AND ?", p, '2026-01-01', '2026-01-31'),
      'debt payment by txn': plan('SELECT * FROM debt_payment WHERE txn_id = ?', 1),
      'rules by profile': plan('SELECT * FROM category_rule WHERE profile_id = ?', p)
    }
    console.log('AUDIT-PLAN\n' + Object.entries(out).map(([k, v]) => `${k.padEnd(36)} ${v}`).join('\n'))
    // anything that scans the whole table for a lookup by key is a problem
    for (const k of ['list by profile and date', 'filter by account and date', 'fingerprint lookup (import dedupe)', 'review queue']) expect(out[k], k).not.toMatch(/SCAN txn\b(?! USING)/)
    db.close()
  })
})
