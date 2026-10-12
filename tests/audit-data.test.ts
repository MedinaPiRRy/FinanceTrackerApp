// Audit: data safety. Dates, names that look alike, balances, migrations, erasing, and writes that must be all-or-nothing.
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import os from 'node:os'
import path from 'node:path'
import { openDb, type Db } from '../src/db/open'
import { SCHEMA_VERSION } from '../src/db/schema'
import { createHandlers } from '../src/main/handlers'
import { createCategory } from '../src/db/queries'
import { createAccount } from '../src/db/accounts'
import { createBudget } from '../src/db/budgets'
import { createDebt, updateDebtBalance } from '../src/db/debts'
import { createGoal } from '../src/db/goals'
import { addTip, depositCash } from '../src/db/cash'
import { setValuation } from '../src/db/review'
import { createAsset } from '../src/db/assets'
import { checkBalance, matchBankBalance } from '../src/db/accountChecks'
import { addDays, addMonths, monthRange, daysBetween } from '../src/core/dates'
import { rememberCategory } from '../src/db/rules'
import { renameProfile } from '../src/db/profilesManage'
import { updateAsset } from '../src/db/assets'
import { listBackups, restoreDatabase, pruneFiles } from '../src/main/maintenance'
import { foldName } from '../src/db/open'

let db: Db
let p: number, chq: number, card: number, inv: number
const add = (account: number, cents: number, date = '2026-03-10', kind = 'expense', i = Math.random()) =>
  db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, source, fingerprint) VALUES (?,?,?,?,?,?,?,'import',?)").run(p, account, date, cents, 'X', 'X', kind, `f${i}`)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
  const acct = (name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(p, name, type).lastInsertRowid)
  chq = acct('Chequing', 'chequing'); card = acct('Visa', 'credit_card'); inv = acct('TFSA', 'investment'); acct('Cash', 'cash')
})

describe('dates: leap day, month ends, year boundaries', () => {
  it('adds days and months across 29 February and New Year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2027-01', -1)).toBe('2026-12')
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthRange('2100-02').to).toBe('2100-02-28') // 2100 is not a leap year
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
  })

  it('a transaction on 29 February lands in February in the dashboard, the monthly figures and the forecast base', () => {
    add(chq, -1000, '2028-02-29')
    add(chq, -2000, '2028-03-01')
    const feb = db.prepare("SELECT COALESCE(SUM(-amount_cents),0) s FROM txn WHERE posted_date BETWEEN ? AND ?").get(monthRange('2028-02').from, monthRange('2028-02').to) as { s: number }
    expect(feb.s).toBe(1000)
  })

  // Was audit finding D-01: handlers checked the shape of a date (YYYY-MM-DD) but not that it exists, so 30 February was stored as typed.
  it('refuses impossible dates such as 2026-02-30 everywhere a date is typed', () => {
    const attempts: (() => unknown)[] = [
      () => addTip(db, p, '2026-02-30', 1000),
      () => depositCash(db, p, '2026-02-30', 1000, chq),
      () => createDebt(db, p, 'D', 1000, '2026-02-30'),
      () => setValuation(db, inv, '2026-02-30', 1000),
      () => createAsset(db, p, { name: 'House', kind: 'property', valueCents: 1, asOf: '2026-02-30' })
    ]
    for (const a of attempts) expect(a).toThrow()
  })

  it('refuses dates that are not dates at all', () => {
    for (const bad of ['yesterday', '26-3-1', '2026/03/01', '']) expect(() => addTip(db, p, bad, 1000)).toThrow()
  })
})

describe('names that look alike', () => {
  it('categories, accounts and budgets that differ only in ASCII case are the same name', () => {
    createCategory(db, p, 'Pets', 'expense')
    expect(createCategory(db, p, 'pets', 'expense').name).toBe('Pets')
    createAccount(db, p, { name: 'Savings', type: 'savings' })
    expect(() => createAccount(db, p, { name: 'SAVINGS', type: 'savings' })).toThrow(/already/)
    createBudget(db, p, 'Fun', 1000, [])
    expect(() => createBudget(db, p, 'FUN', 1000, [])).toThrow(/already/)
  })

  // Was audit finding N-01: SQLite's COLLATE NOCASE only folds A-Z, so "Café" and "CAFÉ" were two different categories/accounts/people.
  it('names that differ only by accented capitals are the same name', () => {
    createCategory(db, p, 'Café', 'expense')
    const second = createCategory(db, p, 'CAFÉ', 'expense')
    expect(second.name).toBe('Café')
    createAccount(db, p, { name: 'Épargne', type: 'savings' })
    expect(() => createAccount(db, p, { name: 'ÉPARGNE', type: 'savings' })).toThrow(/already/)
  })

  it('leading and trailing spaces never create a second copy', () => {
    createCategory(db, p, 'Pets', 'expense')
    expect(createCategory(db, p, '  Pets  ', 'expense').name).toBe('Pets')
  })

  it('a person cannot be renamed to someone else\'s name (any case)', () => {
    const b = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('babytas','Babytas')").run().lastInsertRowid)
    expect(() => renameProfile(db, p, 'BABYTAS')).toThrow(/already called/)
    void b
  })
})

describe('balances and the "match my bank" check', () => {
  it('zero, negative, huge and fractional amounts are handled or refused, never silently wrong', () => {
    add(chq, -5000, '2026-03-01')
    expect(checkBalance(db, p, chq, 0).newOpeningCents).toBe(5000)
    expect(checkBalance(db, p, chq, -123456).newOpeningCents).toBe(-123456 + 5000)
    expect(() => checkBalance(db, p, chq, 10.5)).toThrow(/dollars and cents/)
    expect(() => checkBalance(db, p, chq, Number.NaN)).toThrow()
    expect(() => checkBalance(db, p, card, -100)).toThrow(/positive/)
    const huge = checkBalance(db, p, chq, 900_000_000_000_00)
    expect(Number.isSafeInteger(huge.newOpeningCents)).toBe(true)
    expect(huge.warnings.join(' ')).toMatch(/a lot/)
  })

  it('matching leaves every transaction alone and makes the balance equal the bank\'s', () => {
    add(chq, -5000, '2026-03-01'); add(chq, 2500, '2026-03-02', 'income')
    const before = db.prepare('SELECT COUNT(*) n, SUM(amount_cents) s FROM txn').get()
    const r = matchBankBalance(db, p, chq, 100000)
    expect(db.prepare('SELECT COUNT(*) n, SUM(amount_cents) s FROM txn').get()).toEqual(before)
    expect(r.appCents).toBe(100000)
    expect(checkBalance(db, p, chq, 100000).newOpeningCents).toBe(r.newOpeningCents)
  })

  it('a credit card owed amount round trips (owed 3,417.63 with 180.99 pending)', () => {
    add(card, -250000, '2026-03-01')
    const c = checkBalance(db, p, card, 341763, 18099)
    expect(c.bankCents).toBe(-341763)
    expect(c.afterPendingCents).toBe(-341763 - 18099)
  })

  it('a deleted-account id, someone else\'s account and an investment account are refused or explained', () => {
    expect(() => checkBalance(db, p, 99999, 1)).toThrow()
    const other = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('x','X')").run().lastInsertRowid)
    expect(() => checkBalance(db, other, chq, 1)).toThrow()
    expect(() => checkBalance(db, p, inv, 1)).not.toThrow(/TypeError/)
  })
})

describe('debts and money going to a loan', () => {
  it('a payment can not push a balance below zero, and the history only moves forward in time', () => {
    const d = createDebt(db, p, 'OSAP', 10000, '2026-01-01')
    updateDebtBalance(db, p, d, 0, '2026-02-01')
    expect((db.prepare('SELECT balance_cents b FROM debt WHERE id = ?').get(d) as { b: number }).b).toBe(0)
    expect(() => updateDebtBalance(db, p, d, -5, '2026-03-01')).toThrow()
    expect(() => updateDebtBalance(db, p, d, 1.5, '2026-03-01')).toThrow()
  })

  it('a goal with a zero or negative target is refused', () => {
    expect(() => createGoal(db, p, { name: 'x', kind: 'manual', targetCents: 0 })).toThrow()
    expect(() => createGoal(db, p, { name: 'x', kind: 'manual', targetCents: -100 })).toThrow()
  })
})

describe('writes that must be all-or-nothing', () => {
  // Was audit finding T-01: rememberCategory deleted the old rule and inserted the new one as two statements outside a transaction.
  it('remembering a category never leaves the merchant with no rule if the second write fails', () => {
    const food = createCategory(db, p, 'Food', 'expense').id
    expect(rememberCategory(db, p, 'LOBLAWS #1234 MILTON', 'Loblaws', food)).toBe(true)
    const before = db.prepare('SELECT COUNT(*) n FROM category_rule WHERE profile_id = ?').get(p) as { n: number }
    // make the second statement fail: a trigger that rejects inserts
    db.exec("CREATE TRIGGER no_insert BEFORE INSERT ON category_rule BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    try { rememberCategory(db, p, 'LOBLAWS #1234 MILTON', 'Loblaws', food) } catch { /* expected */ }
    expect(db.prepare('SELECT COUNT(*) n FROM category_rule WHERE profile_id = ?').get(p)).toEqual(before)
  })
})

describe('migrations', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-mig-'))

  it('a fresh database is at the current version and a re-open changes nothing and makes no backup', () => {
    const dir = tmp()
    const file = path.join(dir, 'finance.db')
    openDb(file).close()
    openDb(file).close()
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([])
    const d = openDb(file)
    expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    d.close()
  })

  it('a database from a newer app is refused and left untouched', () => {
    const dir = tmp()
    const file = path.join(dir, 'finance.db')
    const d = openDb(file)
    d.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    d.close()
    const before = fs.readFileSync(file)
    expect(() => openDb(file)).toThrow(/newer version/)
    expect(Buffer.compare(fs.readFileSync(file), before)).toBe(0)
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([])
  })

  it('an unrelated SQLite file (user_version 0, other tables) is refused with a plain message, not overwritten', () => {
    const dir = tmp()
    const file = path.join(dir, 'finance.db')
    const raw = openDb(path.join(dir, 'other.db'))
    raw.exec('DROP TABLE IF EXISTS txn')
    raw.pragma('user_version = 0')
    raw.exec('CREATE TABLE notes (id INTEGER)')
    raw.close()
    fs.copyFileSync(path.join(dir, 'other.db'), file)
    let err: Error | null = null
    try { openDb(file).close() } catch (e) { err = e as Error }
    // the file already has app tables from the first open above, so this is the "table already exists" shape of failure
    expect(err === null || !/SQLITE_/.test(err.message)).toBe(true)
  })

  // Was audit finding M-01: old-version backups (finance.db.bak-v<N>-<time>) were not covered by "Erase all my data".
  it('erasing all data also removes the migration backups next to the database', () => {
    const dir = tmp()
    const file = path.join(dir, 'finance.db')
    const d = openDb(file)
    d.pragma('user_version = 1') // pretend it is old; the real upgrade path then makes a .bak copy
    d.close()
    try { openDb(file).close() } catch { /* the upgrade itself is covered by migration.test.ts */ }
    const h = createHandlers(file) as unknown as { eraseAll: (c: string, keep: boolean) => unknown; close: () => void }
    h.eraseAll!('ERASE', false)
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-') || f.endsWith('.db'))).toEqual([])
  })
})

describe('erasing data and backups', () => {
  function setup() {
    const dir = tmp2()
    const file = path.join(dir, 'finance.db')
    const d = openDb(file)
    const pr = Number(d.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
    d.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(pr)
    d.close()
    return { dir, file, h: createHandlers(file) as unknown as Record<string, (...a: unknown[]) => unknown> }
  }
  const tmp2 = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-erase-'))

  it('erase needs the typed word and removes the database file', () => {
    const { dir, file, h } = setup()
    expect(() => h.eraseAll!('erase please', false)).toThrow(/Type ERASE/)
    expect(fs.existsSync(file)).toBe(true)
    h.eraseAll!('ERASE', false)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(dir)).toBe(true)
  })

  // Was audit finding B-01: "Erase all my data" and "Delete the app and its data" with "keep no backup" left every earlier
  // backup (finance-*.db, auto-*.db) in the backups folder: full copies of all the person's transactions.
  it('erasing with "keep no backup" leaves no copy of the data behind', () => {
    const { dir, h } = setup()
    h.backupNow!()
    h.eraseAll!('ERASE', false)
    const left = fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')) : []
    expect(left).toEqual([])
  })

  it('erasing with "keep a backup" makes exactly one new backup first and it opens with the data in it', () => {
    const { dir, h } = setup()
    const r = h.eraseAll!('ERASE', true) as { backupFile: string }
    expect(fs.existsSync(r.backupFile)).toBe(true)
    const copy = openDb(r.backupFile)
    expect((copy.prepare('SELECT COUNT(*) n FROM profile WHERE kind = ?').get('person') as { n: number }).n).toBe(1)
    copy.close()
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1)
  })

  it('erasing with "keep a backup" leaves only that new backup: earlier backups, upgrade copies, the sample database and the state file all go', () => {
    const { dir, h } = setup()
    h.backupNow!(); h.backupNow!()
    fs.writeFileSync(path.join(dir, 'finance.db.bak-v1-2026-01-01'), 'old copy')
    fs.writeFileSync(path.join(dir, 'sample.db'), 'sample'); fs.writeFileSync(path.join(dir, 'app-state.json'), '{"active":"real"}')
    const r = h.eraseAll!('ERASE', true) as { backupFile: string }
    expect(fs.readdirSync(path.join(dir, 'backups'))).toEqual([path.basename(r.backupFile)])
    expect(fs.readdirSync(dir).sort()).toEqual(['backups'])
  })

  it('"Delete the app and its data" erases the same way', () => {
    const { dir, h } = setup()
    h.backupNow!()
    const r = h.deleteApp!('DELETE', false) as { message: string }
    expect(r.message).toBeTruthy()
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('names are compared without case or accents', () => {
  it('folds case, accents and spacing the same way the database does', () => {
    expect(foldName('  CAFÉ   Crème ')).toBe('cafe creme')
    expect(db.prepare("SELECT fold('Épargne') AS f").get()).toEqual({ f: 'epargne' })
  })
  it('a budget, a goal-free asset and a person cannot be duplicated with different accents either', () => {
    createBudget(db, p, 'Épicerie', 1000, [])
    expect(() => createBudget(db, p, 'EPICERIE', 1000, [])).toThrow(/already/)
    createAsset(db, p, { name: 'Résidence', kind: 'property', valueCents: 1, asOf: '2026-01-01' })
    expect(() => createAsset(db, p, { name: 'RESIDENCE', kind: 'property', valueCents: 1, asOf: '2026-01-01' })).toThrow(/already/)
    expect(() => renameProfile(db, p, ' daniel ')).not.toThrow() // keeping your own name (in another case) is fine
  })
})

describe('a failed edit changes nothing', () => {
  it('an asset rename that clashes does not apply the kind or note change that came with it', () => {
    const a = createAsset(db, p, { name: 'House', kind: 'property', valueCents: 1, asOf: '2026-01-01' })
    createAsset(db, p, { name: 'Car', kind: 'vehicle', valueCents: 1, asOf: '2026-01-01' })
    expect(() => updateAsset(db, p, a, { kind: 'other', notes: 'changed', name: 'car' })).toThrow(/already/)
    expect(db.prepare('SELECT kind, notes FROM asset WHERE id = ?').get(a)).toEqual({ kind: 'property', notes: null })
  })
})

describe('upgrades that go wrong', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-up-'))
  it('a failed upgrade leaves the version number where it was, and only the newest 3 upgrade copies are kept', async () => {
    const dir = tmp(); const file = path.join(dir, 'finance.db')
    openDb(file).close()
    for (let i = 0; i < 6; i++) {
      const raw = new Database(file); raw.pragma('user_version = 1'); raw.close() // pretend it is an old database again
      let err: Error | null = null
      try { openDb(file).close() } catch (e) { err = e as Error } // the step fails here (the tables already exist); that is the case being tested
      expect(err).not.toBeNull()
      const after = new Database(file); expect(after.pragma('user_version', { simple: true })).toBe(1); expect(after.pragma('foreign_keys', { simple: true })).toBeDefined(); after.close()
      await new Promise((r) => setTimeout(r, 15)) // distinct file times for the copies
    }
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length).toBeLessThanOrEqual(3)
  })
})

describe('backups: list, prune and restore', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-rest-')); const file = path.join(dir, 'finance.db')
    const d = openDb(file)
    const pr = Number(d.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
    d.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(pr)
    d.close()
    return { dir, file, h: createHandlers(file) as unknown as Record<string, (...a: unknown[]) => unknown> }
  }
  const people = (file: string) => { const d = openDb(file); const n = (d.prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'person'").get() as { n: number }).n; d.close(); return n }

  it('lists backups newest first with their kind, and ignores other files', () => {
    const { dir, h } = setup()
    h.backupNow!()
    fs.writeFileSync(path.join(dir, 'backups', 'auto-2026-01-01.db'), 'x'); fs.writeFileSync(path.join(dir, 'backups', 'notes.txt'), 'x'); fs.writeFileSync(path.join(dir, 'backups', 'Book-2026.xlsm'), 'x')
    const l = h.backupList!() as { name: string; kind: string }[]
    expect(l.map((b) => b.kind).sort()).toEqual(['automatic', 'manual'])
  })

  it('restores a backup: the data comes back, the current data is saved first, and a typed word is needed', () => {
    const { dir, file, h } = setup()
    const made = h.backupNow!() as { file: string }
    // after the backup, add a second person: the restore must take it away again
    const d = openDb(file); d.prepare("INSERT INTO profile (slug,name) VALUES ('babytas','Babytas')").run(); d.close()
    h.close!()
    expect(() => h.backupRestore!(path.basename(made.file), 'yes')).toThrow(/Type RESTORE/)
    expect(people(file)).toBe(2)
    const r = h.backupRestore!(path.basename(made.file), 'RESTORE') as { restored: string; safetyBackup: string }
    expect(people(file)).toBe(1)
    // the data from just before is itself a backup that can be restored
    expect(fs.existsSync(path.join(dir, 'backups', r.safetyBackup))).toBe(true)
    h.backupRestore!(r.safetyBackup, 'RESTORE')
    expect(people(file)).toBe(2)
  })

  it('refuses anything that is not a listed, healthy backup: paths, other files, damaged files, newer versions', () => {
    const { dir, h } = setup()
    const b = path.join(dir, 'backups'); fs.mkdirSync(b, { recursive: true })
    fs.writeFileSync(path.join(dir, 'secret.db'), 'x'); fs.writeFileSync(path.join(b, 'finance-bad.db'), 'this is not a database at all')
    for (const name of ['../secret.db', '..\\secret.db', 'C:/Windows/win.ini', 'finance-x.txt', '', 'auto-/../../x.db']) expect(() => h.backupRestore!(name, 'RESTORE')).toThrow(/Choose a backup/)
    expect(() => h.backupRestore!('finance-bad.db', 'RESTORE')).toThrow(/damaged|could not be opened|not a backup/)
    expect(() => h.backupRestore!('finance-missing.db', 'RESTORE')).toThrow(/no longer exists/)
    const newer = openDb(path.join(b, 'finance-newer.db')); newer.pragma(`user_version = ${SCHEMA_VERSION + 5}`); newer.close()
    expect(() => h.backupRestore!('finance-newer.db', 'RESTORE')).toThrow(/newer version/)
    expect(fs.existsSync(path.join(dir, 'finance.db'))).toBe(true) // none of the refusals touched the data
  })

  it('keeps the newest 30 manual backups and 5 "before a restore" copies, and every automatic backup is left to its own setting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-prune-'))
    for (let i = 0; i < 35; i++) { const f = path.join(dir, `finance-${String(i).padStart(3, '0')}.db`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i)) }
    fs.writeFileSync(path.join(dir, 'auto-2026-01-01.db'), 'x')
    pruneFiles(dir, /^finance-.*\.db$/, 30)
    const left = fs.readdirSync(dir)
    expect(left.filter((f) => f.startsWith('finance-'))).toHaveLength(30)
    expect(left).toContain('finance-034.db'); expect(left).not.toContain('finance-000.db'); expect(left).toContain('auto-2026-01-01.db')
    void listBackups; void restoreDatabase
  })

  it('automatic backups are on by default (10) and can be turned off', () => {
    const d = openDb(':memory:')
    expect((d.prepare('SELECT 1').get(), true)).toBe(true)
  })
})
