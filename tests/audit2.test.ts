// Second audit: things found by walking the finished app and reading the newer code. Each test states what SHOULD happen; a test marked it.fails
// is a confirmed problem (the test passes only while the problem exists) and is listed in the audit report.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/open'
import { createHandlers } from '../src/main/handlers'
import { restoreDatabase } from '../src/main/maintenance'
import { costsReport } from '../src/db/costsReport'
import { costKind, guessPurpose } from '../src/core/costs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-a2-'))

function costDb() {
  const db = openDb(':memory:')
  const p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
  const a = Number(db.prepare("INSERT INTO account (profile_id,name,type) VALUES (?, 'Chequing','chequing')").run(p).lastInsertRowid)
  const fees = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Bank Fees & Interest','expense')").run(p).lastInsertRowid)
  let n = 0
  const add = (desc: string, cents: number) => db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,'2026-05-10',?,?,?,'expense',?,'import',?)").run(p, a, cents, desc, desc, fees, `c${n++}`)
  return { db, p, add }
}

describe('Taxes & interest', () => {
  // Was second-audit finding F-1 (medium): the starter category is called "Bank Fees & Interest", and a category whose name contains "interest" is guessed to be
  // interest, so every bank FEE in it (overdraft fees, cash-advance fees, monthly fees) is added to the interest total. On the personal fixture data
  // this made "interest" $345.59, of which only part was interest.
  it('a bank fee in "Bank Fees & Interest" is not counted as interest, only lines that say interest are', () => {
    const { db, p, add } = costDb()
    add('Pay Per Use Overdraft Fee', -500); add('Cash-Advance Fee', -500); add('Purchase Interest', -4629)
    expect(costsReport(db, [p], 2026).interestCents).toBe(4629)
  })

  // Was second-audit finding F-2 (low): any description containing the word "interest" counts, including promotions that say there is none.
  it('"no interest" and "interest-free" promotions are not interest paid', () => {
    for (const d of ['NO INTEREST PROMO PURCHASE', 'INTEREST FREE FINANCING PAYMENT']) {
      expect(costKind({ kind: 'expense', amountCents: -10000, description: d, categoryPurpose: null, categoryName: 'Shopping' })).toBeNull()
    }
  })

  it('the name guess still catches the real thing and ignores look-alikes', () => {
    expect(['Income Tax', 'HST/GST', 'CRA payments', 'Property taxes'].map(guessPurpose)).toEqual(['tax', 'tax', 'tax', 'tax'])
    expect(['Crafts', 'Taxi & Rideshare', 'Syntax Books', 'Interior'].map(guessPurpose)).toEqual(['none', 'none', 'none', 'none'])
    expect(costKind({ kind: 'expense', amountCents: -500, description: 'PURCHASE INTEREST', categoryPurpose: null, categoryName: 'Bank Fees' })).toBe('interest')
  })
})

describe('sample data and backups', () => {
  // Was second-audit finding N-1 (medium): while sample data is open, "Back up my data now" copies the SAMPLE database into the same backups folder as
  // the real backups, under the same name pattern. After leaving the sample, the Restore list offers it, and restoring it replaces the person's
  // real data with made-up data (the data from just before is saved, so it can be undone, but the list is misleading).
  it('a backup made while the sample is open is not offered as a restore point for real data', async () => {
    const dir = tmp(); const file = path.join(dir, 'finance.db')
    const real = openDb(file)
    real.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run(); real.close()
    const h = createHandlers(file) as unknown as Record<string, (...a: unknown[]) => unknown>
    h.startSample!('single')
    h.backupNow!()
    h.endSample!()
    expect((h.backupList!() as unknown[]).length).toBe(0)
  })
})

describe('restoring a backup', () => {
  // Was second-audit finding R-2 (medium): restoreDatabase deletes the current database and then copies the backup over it. If the copy fails (disk full, the
  // file is locked by an antivirus scan), the app is left with no database at all; the data is only in the "before a restore" backup.
  it('a failed copy leaves the current database in place', () => {
    const dir = tmp(); const target = path.join(dir, 'finance.db'); const backups = path.join(dir, 'backups'); fs.mkdirSync(backups)
    const db = openDb(target); db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run(); db.close()
    const good = openDb(path.join(backups, 'finance-2026-01-01.db')); good.prepare("INSERT INTO profile (slug,name) VALUES ('x','X')").run(); good.close()
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('ENOSPC: no space left on device') })
    try {
      expect(() => restoreDatabase(backups, 'finance-2026-01-01.db', target, (f) => fs.writeFileSync(f, 'saved'), () => undefined)).toThrow(/ENOSPC/)
    } finally { spy.mockRestore() }
    expect(fs.existsSync(target)).toBe(true)
  })
})

describe('the fixes keep what was right', () => {
  it('a category named only for interest, or one the person marks as Interest, still counts all its lines', () => {
    expect(guessPurpose('Loan Interest')).toBe('interest')
    expect(guessPurpose('Bank Fees & Interest')).toBe('none')
    const { db, p, add } = costDb()
    add('Overdraft Fee', -500); add('Purchase Interest', -4629)
    const cat = (db.prepare("SELECT id FROM category WHERE name = 'Bank Fees & Interest'").get() as { id: number }).id
    db.prepare("UPDATE category SET purpose = 'interest' WHERE id = ?").run(cat)
    expect(costsReport(db, [p], 2026).interestCents).toBe(5129)
  })
  it('a failed restore leaves no half-copied file behind, and a good one replaces the database in one step', () => {
    const dir = tmp(); const target = path.join(dir, 'finance.db'); const backups = path.join(dir, 'backups'); fs.mkdirSync(backups)
    const db = openDb(target); db.prepare("INSERT INTO profile (slug,name) VALUES ('old','Old')").run(); db.close()
    const good = openDb(path.join(backups, 'finance-2026-01-01.db')); good.prepare("INSERT INTO profile (slug,name) VALUES ('new','New')").run(); good.close()
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('ENOSPC') })
    try { expect(() => restoreDatabase(backups, 'finance-2026-01-01.db', target, (f) => fs.writeFileSync(f, 's'), () => undefined)).toThrow(/ENOSPC/) } finally { spy.mockRestore() }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.restoring'))).toEqual([])
    restoreDatabase(backups, 'finance-2026-01-01.db', target, (f) => fs.writeFileSync(f, 's'), () => undefined)
    const after = openDb(target); expect((after.prepare("SELECT slug FROM profile WHERE slug IN ('old','new')").all() as { slug: string }[]).map((r) => r.slug)).toEqual(['new']); after.close()
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.restoring'))).toEqual([])
  })
})

describe('sample backups stay out of the real list', () => {
  it('are kept in their own folder, which leaving the sample and erasing both remove', () => {
    const dir = tmp(); const file = path.join(dir, 'finance.db')
    const real = openDb(file); real.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run(); real.close()
    const h = createHandlers(file) as unknown as Record<string, (...a: unknown[]) => unknown>
    h.backupNow!() // a real backup first
    h.startSample!('single'); h.backupNow!()
    expect(fs.readdirSync(path.join(dir, 'sample-backups'))).toHaveLength(1)
    h.endSample!()
    expect(fs.existsSync(path.join(dir, 'sample-backups'))).toBe(false)
    expect((h.backupList!() as unknown[]).length).toBe(1)
  })
})
