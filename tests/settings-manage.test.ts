import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type Db } from '../src/db/open'
import { createSetup, getAppMode } from '../src/db/defaults'
import { getAppSettings, setAppSetting } from '../src/db/appSettings'
import { listCategoryManage, renameCategory, deleteCategory, setCategoryBudget } from '../src/db/categoriesManage'
import { createBudget, listBudgets } from '../src/db/budgets'
import { createAccount, updateAccount, deleteAccount } from '../src/db/accounts'
import { renameProfile } from '../src/db/profilesManage'
import { exportTransactionsCsv, csvField } from '../src/db/exportCsv'
import { autoBackupIfDue } from '../src/main/maintenance'
import { createHandlers } from '../src/main/handlers'
import { addPartner, addHousehold, removeHousehold, removePartner } from '../src/db/modeChange'
import { reviewNotice } from '../src/db/review'

let db: Db
let p: number, chq: number, card: number
let n = 0
const cat = (name: string, kind = 'expense') => Number(db.prepare('INSERT INTO category (profile_id, name, kind) VALUES (?,?,?)').run(p, name, kind).lastInsertRowid)
const add = (account: number, cents: number, text: string, kind = 'expense', category: number | null = null, date = '2026-09-01') =>
  Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(p, account, date, cents, text, text, kind, category, `m${n++}`).lastInsertRowid)

beforeEach(() => {
  db = openDb(':memory:')
  ;[p] = createSetup(db, 'single', [{ name: 'Sam', accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Card', type: 'credit_card' }] }]) as [number]
  chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
  card = (db.prepare("SELECT id FROM account WHERE name = 'Card'").get() as { id: number }).id
})

describe('general settings', () => {
  it('have sensible defaults, validate what they accept, and drive the "older" cut-off', () => {
    expect(getAppSettings(db)).toEqual({ olderAfterDays: 90, startPage: 'dashboard', autoBackupKeep: 0 })
    expect(setAppSetting(db, 'olderAfterDays', 30).olderAfterDays).toBe(30)
    expect(() => setAppSetting(db, 'olderAfterDays', 45)).toThrow(/30, 90, 180 or 365/)
    expect(() => setAppSetting(db, 'startPage', 'secret' as never)).toThrow(/page from the list/)
    expect(() => setAppSetting(db, 'autoBackupKeep', 7)).toThrow(/off, 5, 10 or 20/)
    add(chq, 2000, 'E-TRANSFER X', 'unclassified')
    db.prepare("UPDATE txn SET review_reason = 'x', posted_date = '2026-08-20'").run() // 45 days before 2026-10-04
    expect(reviewNotice(db, p, '2026-10-04')).toEqual({ recent: 0, older: 1, days: 30 })
    setAppSetting(db, 'olderAfterDays', 90)
    expect(reviewNotice(db, p, '2026-10-04')).toEqual({ recent: 1, older: 0, days: 90 })
  })
})

describe('renaming people', () => {
  it('renames a person, keeps the slug, and refuses empty, duplicate and reserved names', () => {
    renameProfile(db, p, '  Sam   Lee ')
    expect(db.prepare('SELECT name, slug FROM profile WHERE id = ?').get(p)).toEqual({ name: 'Sam Lee', slug: 'sam' })
    expect(() => renameProfile(db, p, ' ')).toThrow(/Enter a name/)
    expect(() => renameProfile(db, p, 'household')).toThrow(/shared view/)
    expect(() => renameProfile(db, 999, 'X')).toThrow(/no longer exists/)
    addPartner(db, { name: 'Jo', accounts: [] })
    expect(() => renameProfile(db, p, 'jo')).toThrow(/already called/)
  })
})

describe('category manager', () => {
  it('lists usage, renames (no clashes), and assigns a spending category to a budget', () => {
    const food = cat('Food M'), fun = cat('Fun M'), pay = cat('Pay M', 'income')
    add(chq, -1000, 'SHOP', 'expense', food)
    const b = createBudget(db, p, 'Everyday', 50000, [food])
    const row = listCategoryManage(db, p).find((c) => c.id === food)!
    expect(row).toMatchObject({ name: 'Food M', txnCount: 1, budgetName: 'Everyday' })
    renameCategory(db, p, food, 'Groceries M')
    expect(() => renameCategory(db, p, fun, 'groceries m')).toThrow(/already a spending category/)
    expect(() => renameCategory(db, p, fun, '   ')).toThrow(/cannot be empty/)
    expect(() => setCategoryBudget(db, p, pay, b)).toThrow(/spending categories only/)
    setCategoryBudget(db, p, fun, b)
    expect(listBudgets(db, p).find((x) => x.id === b)!.categoryIds.sort()).toEqual([food, fun].sort())
    setCategoryBudget(db, p, fun, null)
    expect(listBudgets(db, p).find((x) => x.id === b)!.categoryIds).toEqual([food])
  })

  it('deleting a used category moves its transactions, rules, goals and budget place to another', () => {
    const a = cat('Old A'), b = cat('New A')
    const t1 = add(chq, -1000, 'SHOP', 'expense', a)
    db.prepare("INSERT INTO category_rule (profile_id, pattern, match_type, merchant, category_id, priority, source) VALUES (?, 'SHOP', 'exact', 'Shop', ?, 10, 'user')").run(p, a)
    db.prepare("INSERT INTO goal (profile_id, name, kind, target_cents, category_id) VALUES (?, 'G', 'category', 1000, ?)").run(p, a)
    const bud = createBudget(db, p, 'Bud', 1000, [a])
    expect(() => deleteCategory(db, p, a, null)).toThrow(/Pick the category to move/)
    expect(() => deleteCategory(db, p, a, a)).toThrow(/different category/)
    expect(() => deleteCategory(db, p, a, cat('Income A', 'income'))).toThrow(/spending category/)
    expect(deleteCategory(db, p, a, b)).toEqual({ moved: 1 })
    expect((db.prepare('SELECT category_id c FROM txn WHERE id = ?').get(t1) as { c: number }).c).toBe(b)
    expect(db.prepare('SELECT category_id c FROM category_rule WHERE pattern = ?').get('SHOP')).toEqual({ c: b })
    expect(db.prepare('SELECT category_id c FROM goal').get()).toEqual({ c: b })
    expect(listBudgets(db, p).find((x) => x.id === bud)!.categoryIds).toEqual([b])
    expect(db.prepare('SELECT 1 FROM category WHERE id = ?').get(a)).toBeUndefined()
  })

  it('an unused category is simply removed; a move target that is already in a budget wins', () => {
    const lone = cat('Lone'), x = cat('X1'), y = cat('Y1')
    expect(deleteCategory(db, p, lone, null)).toEqual({ moved: 0 })
    const b1 = createBudget(db, p, 'B1', 100, [x]), b2 = createBudget(db, p, 'B2', 100, [y])
    deleteCategory(db, p, x, y)
    expect(listBudgets(db, p).find((q) => q.id === b1)!.categoryIds).toEqual([])
    expect(listBudgets(db, p).find((q) => q.id === b2)!.categoryIds).toEqual([y])
  })
})

describe('accounts: edit and delete', () => {
  it('edits name, institution and credit limit', () => {
    updateAccount(db, p, card, { name: 'Rewards Visa', institution: ' Big Bank ', creditLimitCents: 500000 })
    expect(db.prepare('SELECT name, institution, credit_limit_cents l FROM account WHERE id = ?').get(card)).toEqual({ name: 'Rewards Visa', institution: 'Big Bank', l: 500000 })
    expect(() => updateAccount(db, p, chq, { creditLimitCents: 1000 })).toThrow(/Only credit cards/)
    expect(() => updateAccount(db, p, card, { name: 'Chequing' })).toThrow(/already an account/)
  })

  it('deletes an empty account, but never the Cash wallet, and not one a goal or bill uses', () => {
    const extra = createAccount(db, p, { name: 'Spare', type: 'savings' })
    expect(deleteAccount(db, p, extra)).toEqual({ movedTransactions: 0, deletedTransactions: 0 })
    const cash = (db.prepare("SELECT id FROM account WHERE type = 'cash'").get() as { id: number }).id
    expect(() => deleteAccount(db, p, cash)).toThrow(/Cash wallet/)
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency) VALUES (?, 'Rent', 'expense', ?, 1000, 'monthly')").run(p, chq)
    expect(() => deleteAccount(db, p, chq)).toThrow(/Rent/)
  })

  it('an account with transactions needs a decision: move them, or delete them with a typed confirmation', () => {
    const t1 = add(card, -500, 'A'), t2 = add(card, -700, 'B')
    expect(() => deleteAccount(db, p, card)).toThrow(/2 transactions/)
    expect(() => deleteAccount(db, p, card, { deleteTransactions: true, confirmName: 'card' })).toThrow(/Type the account name exactly/)
    expect(() => deleteAccount(db, p, card, { moveToAccountId: card })).toThrow(/different account/)
    expect(() => deleteAccount(db, p, card, { moveToAccountId: 99999 })).toThrow(/one of your own/)
    expect(deleteAccount(db, p, card, { moveToAccountId: chq })).toEqual({ movedTransactions: 2, deletedTransactions: 0 })
    expect((db.prepare('SELECT account_id a FROM txn WHERE id = ?').get(t2) as { a: number }).a).toBe(chq)
    expect(db.prepare('SELECT 1 FROM account WHERE id = ?').get(card)).toBeUndefined()
    expect(t1).toBeGreaterThan(0)
  })

  it('deleting with the transactions removes them, unlinks transfer halves and clears its import batches', () => {
    add(card, -500, 'A')
    const half = add(card, 900, 'PAYMENT', 'transfer'); const other = add(chq, -900, 'PAYMENT', 'transfer')
    db.prepare("UPDATE txn SET transfer_group = 'g1' WHERE id IN (?, ?)").run(half, other)
    const batch = Number(db.prepare("INSERT INTO import_batch (profile_id, source, filename, account_id) VALUES (?, 'import', 'f.csv', ?)").run(p, card).lastInsertRowid)
    db.prepare('UPDATE txn SET import_batch_id = ? WHERE account_id = ?').run(batch, card)
    expect(deleteAccount(db, p, card, { deleteTransactions: true, confirmName: 'Card' })).toEqual({ movedTransactions: 0, deletedTransactions: 2 })
    expect(db.prepare('SELECT transfer_group g FROM txn WHERE id = ?').get(other)).toEqual({ g: null })
    expect(db.prepare('SELECT 1 FROM import_batch WHERE id = ?').get(batch)).toBeUndefined()
  })
})

describe('export to CSV', () => {
  it('quotes fields, keeps amounts numeric, and defuses spreadsheet formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvField(null)).toBe('')
    add(chq, -1250, '=HYPERLINK("x")', 'expense', null, '2026-09-02')
    add(chq, 5000, 'PAY, ACME', 'income', null, '2026-09-01')
    const r = exportTransactionsCsv(db, p)
    expect(r.count).toBe(2)
    expect(r.fileName).toMatch(/^transactions-sam-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(r.csv.split('\r\n')).toEqual([
      'Date,Person,Account,Description,Category,Type,Amount,Notes,Needs review',
      '2026-09-01,Sam,Chequing,"PAY, ACME",,income,50.00,,',
      `2026-09-02,Sam,Chequing,"'=HYPERLINK(""x"")",,expense,-12.50,,`,
      ''
    ])
  })
})

describe('automatic backups', () => {
  it('makes one a day, keeps only the newest few, and never touches manual backups', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bak-'))
    const make = (f: string) => fs.writeFileSync(f, 'x')
    fs.writeFileSync(path.join(dir, 'finance-manual.db'), 'm')
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) autoBackupIfDue(dir, 5, d, make)
    expect(autoBackupIfDue(dir, 0, '2026-10-04', make)).toBeNull()
    expect(autoBackupIfDue(dir, 5, '2026-10-03', make)).toBeNull() // already made today
    autoBackupIfDue(dir, 2, '2026-10-04', make)
    expect(fs.readdirSync(dir).sort()).toEqual(['auto-2026-10-03.db', 'auto-2026-10-04.db', 'finance-manual.db'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('erasing everything and deleting the app', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-erase-'))
    const file = path.join(dir, 'finance.db')
    const h = createHandlers(file, { startUninstaller: () => ({ started: true, message: 'opening' }) })
    h.setupOwn('single', [{ name: 'Sam', accounts: [] }])
    return { dir, file, h }
  }

  it('needs the typed word, optionally keeps a backup, and returns to an empty app', () => {
    const { dir, file, h } = setup()
    expect(() => h.eraseAll('erase', false)).toThrow(/Type ERASE/)
    expect(fs.existsSync(file)).toBe(true)
    const r = h.eraseAll('ERASE', true)
    expect(r.backupFile && fs.existsSync(r.backupFile)).toBeTruthy()
    expect(fs.existsSync(file)).toBe(false)
    expect(h.status().hasData).toBe(false) // a fresh empty database is created on the next use
    h.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('deleting the app erases first and then starts the uninstaller; a wrong word does nothing', () => {
    const { dir, file, h } = setup()
    expect(() => h.deleteApp('ERASE', false)).toThrow(/Type DELETE/)
    expect(fs.existsSync(file)).toBe(true)
    const r = h.deleteApp('DELETE', false)
    expect(r).toMatchObject({ backupFile: null, uninstallerStarted: true, message: 'opening' })
    h.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('changing the setup', () => {
  it('adds a partner, then a shared household', () => {
    expect(getAppMode(db)).toBe('single')
    expect(() => addHousehold(db)).toThrow(/Add your partner first/)
    const jo = addPartner(db, { name: 'Jo', accounts: [{ name: 'Chequing', type: 'chequing' }] })
    expect(getAppMode(db)).toBe('couple')
    expect(db.prepare('SELECT COUNT(*) n FROM account WHERE profile_id = ?').get(jo)).toEqual({ n: 2 }) // Cash + Chequing
    expect(db.prepare('SELECT COUNT(*) n FROM category WHERE profile_id = ?').get(jo)).not.toEqual({ n: 0 })
    expect(() => addPartner(db, { name: 'X', accounts: [] })).toThrow(/already has a partner/)
    addHousehold(db)
    expect(getAppMode(db)).toBe('couple_household')
    expect(db.prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'household'").get()).toEqual({ n: 1 })
  })

  it('removing the household deletes its data and turns transfers with it into items to review', () => {
    addPartner(db, { name: 'Jo', accounts: [] })
    const hh = addHousehold(db)
    const shared = Number(db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Joint', 'chequing')").run(hh).lastInsertRowid)
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, source, fingerprint) VALUES (?,?,'2026-09-01',100,'in','income','manual','h1')").run(hh, shared)
    const mine = add(chq, -5000, 'TO JOINT', 'transfer')
    db.prepare('UPDATE txn SET counterparty_profile_id = ?, transfer_group = ? WHERE id = ?').run(hh, 'tg', mine)
    expect(() => removeHousehold(db, 'remove')).toThrow(/Type REMOVE/)
    removeHousehold(db, 'REMOVE')
    expect(getAppMode(db)).toBe('couple')
    expect(db.prepare('SELECT COUNT(*) n FROM account WHERE name = ?').get('Joint')).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'household'").get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT kind, counterparty_profile_id c, review_reason r FROM txn WHERE id = ?').get(mine)).toMatchObject({ kind: 'unclassified', c: null })
  })

  it('removing the partner needs their name typed, and the household must go first', () => {
    const jo = addPartner(db, { name: 'Jo', accounts: [] })
    addHousehold(db)
    expect(() => removePartner(db, jo, 'Jo')).toThrow(/household first/)
    removeHousehold(db, 'REMOVE')
    expect(() => removePartner(db, jo, 'jo')).toThrow(/exactly/)
    removePartner(db, jo, 'Jo')
    expect(getAppMode(db)).toBe('single')
    expect(db.prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'person'").get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM account WHERE profile_id = ?').get(jo)).toEqual({ n: 0 })
  })
})
