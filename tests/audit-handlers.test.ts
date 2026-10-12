// Audit: every handler the renderer can call, hit with hostile arguments (wrong types, huge, negative, NaN, path-like, SQL-like text).
// Nothing may hang or crash the process, the database must stay healthy, money columns must stay whole cents, and error text must not leak internals.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/open'
import { createHandlers } from '../src/main/handlers'
import { dispatch } from '../src/main/dispatch'

// handlers that start other programs or reach outside the temp folder are exercised separately (see the updater and Excel audit tests)
const SKIP = new Set(['close', 'syncRun', 'exportExcel', 'updateInstall', 'importWorkbooks', 'syncPreview'])

const BIG = 'a'.repeat(200_000)
const HOSTILE: unknown[][] = [
  [], [null], [undefined, undefined, undefined], ['x'], [-1], [0], [1e308], [Number.NaN], [{}], [[]], [BIG], ['../../../../Windows/win.ini'], ["'; DROP TABLE txn;--"],
  [1, 'x'], [1, 1, 1], [1, -5, 1e15], [1, { limit: -1, offset: 'x', sort: 'constructor', kind: "x') OR 1=1--" }], [[1, 2, 3], { kind: 'transfer' }], [1, 1.5, 2.5], [{ __proto__: { polluted: true } }],
  [1, '2026-02-30', 100], [1, '9999-99-99', -100], ['__proto__'], [Object.create(null)]
]
const SECRET_LEAKS = /SQLITE_|better-sqlite3|node_modules|\bat [\w.<>]+ \(|\.ts:\d+|[A-Z]:\\\\|TypeError|ReferenceError|Cannot read propert|is not a function|undefined is not|\[object /

let dir: string
let handlers: Record<string, unknown>
let dbFile: string
const seen: { method: string; args: string; error: string }[] = []
let calls = 0

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-audit-'))
  dbFile = path.join(dir, 'finance.db')
  const db = openDb(dbFile)
  const prof = (slug: string, name: string) => Number(db.prepare('INSERT INTO profile (slug, name) VALUES (?, ?)').run(slug, name).lastInsertRowid)
  const d = prof('daniel', 'Daniel'), b = prof('babytas', 'Babytas')
  for (const p of [d, b]) {
    const acct = (name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id, name, type) VALUES (?,?,?)').run(p, name, type).lastInsertRowid)
    const chq = acct('Chequing', 'chequing'); acct('Visa', 'credit_card'); acct('Cash', 'cash'); acct('Savings', 'savings')
    const cat = (n: string, k: string) => Number(db.prepare('INSERT INTO category (profile_id, name, kind) VALUES (?,?,?)').run(p, n, k).lastInsertRowid)
    const food = cat('Food', 'expense'), pay = cat('Pay', 'income')
    let i = 0
    for (let m = 1; m <= 6; m++) {
      db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(p, chq, `2026-0${m}-05`, 300000, 'ACME PAYROLL', 'ACME PAYROLL', 'income', pay, `a${p}${i++}`)
      db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(p, chq, `2026-0${m}-12`, -45000, 'LOBLAWS', 'LOBLAWS', 'expense', food, `a${p}${i++}`)
    }
  }
  db.close()
  process.env.FINANCE_WORKBOOK_DIR = dir // a personal-app build looks for workbooks here; the temp folder has none
  handlers = createHandlers(dbFile, { quit: () => undefined, startUninstaller: () => ({ started: false, message: 'test' }), saveTextFile: async () => null }) as unknown as Record<string, unknown>
  const names = Object.keys(handlers).filter((n) => !SKIP.has(n) && typeof handlers[n] === 'function')
  for (const method of names) {
    for (const args of HOSTILE) {
      calls++
      let r: Awaited<ReturnType<typeof dispatch>>
      try { r = await Promise.race([dispatch(handlers, method, args), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG')), 8000))]) } catch (e) { seen.push({ method, args: JSON.stringify(args).slice(0, 80), error: `THREW ${(e as Error).message}` }); continue }
      if (!r.ok) seen.push({ method, args: JSON.stringify(args, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)).slice(0, 80), error: r.error })
    }
  }
}, 600_000)

afterAll(() => { try { (handlers.close as () => void)() } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }) })

describe('hostile arguments to every handler', () => {
  it('never throws out of dispatch and never hangs', () => {
    expect(calls).toBeGreaterThan(1000)
    expect(seen.filter((s) => s.error.startsWith('THREW'))).toEqual([])
  })

  it('leaves the database healthy: integrity check passes, no orphaned rows, money stays whole cents', () => {
    ;(handlers.close as () => void)()
    const db = openDb(dbFile)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('foreign_key_check')).toEqual([])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name)
    const bad: string[] = []
    for (const t of tables) {
      const cols = (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name).filter((c) => /_cents$|^cents$|_bps$/.test(c))
      for (const c of cols) {
        const n = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE typeof(${c}) NOT IN ('integer','null')`).get() as { n: number }).n
        if (n > 0) bad.push(`${t}.${c}: ${n} non-integer value(s)`)
      }
    }
    expect(bad).toEqual([])
    db.close()
  })

  // Was audit finding A-03: malformed arguments surfaced raw JavaScript errors ("x.trim is not a function") instead of a plain message.
  it('error messages do not expose internals (SQL errors, stack frames, file paths, JavaScript type errors)', () => {
    const leaks = seen.filter((s) => SECRET_LEAKS.test(s.error))
    // keep the list readable in a failure: one line per handler
    const byMethod = [...new Set(leaks.map((l) => `${l.method}: ${l.error.slice(0, 90)}`))]
    expect(byMethod).toEqual([])
  })
})

describe('the dispatcher only runs real handlers', () => {
  // Was audit finding A-02: dispatch() looked the name up with handlers[method], so inherited members such as "constructor" and "toString" were callable.
  for (const name of ['constructor', 'toString', 'isPrototypeOf']) {
    it(`refuses the inherited object member "${name}"`, async () => {
      const r = await dispatch(handlers, name, [])
      expect(r.ok).toBe(false)
    })
  }
  for (const name of ['__proto__', 'hasOwnProperty', 'valueOf']) {
    it(`refuses the member "${name}"`, async () => {
      const r = await dispatch(handlers, name, [])
      expect(r.ok).toBe(false)
    })
  }
})
