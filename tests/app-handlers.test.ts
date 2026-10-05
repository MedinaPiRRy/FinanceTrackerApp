import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createHandlers } from '../src/main/handlers'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-app-'))

describe('diagnostics and backup', () => {
  it('reports facts about the install without any financial detail', () => {
    const dir = tmp()
    const h = createHandlers(path.join(dir, 'finance.db'))
    const d = h.diagnostics()
    expect(d).toMatchObject({ schemaVersion: 1, transactions: 0, platform: process.platform })
    expect(d.dbPath).toBe(path.join(dir, 'finance.db'))
    expect(d.backupDir).toBe(path.join(dir, 'backups'))
    expect(Object.keys(d)).not.toContain('balance')
    h.close()
  })

  it('"Back up my data" writes a complete, openable copy of the database and leaves the original alone', () => {
    const dir = tmp()
    const file = path.join(dir, 'finance.db')
    const h = createHandlers(file)
    h.status() // opens the database
    const raw = new Database(file)
    const pid = Number(raw.prepare("INSERT INTO profile (slug,name) VALUES ('alex','Alex')").run().lastInsertRowid)
    const aid = Number(raw.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(pid, 'Chequing', 'chequing').lastInsertRowid)
    for (let i = 0; i < 50; i++) raw.prepare("INSERT INTO txn (profile_id,account_id,posted_date,amount_cents,description,kind,source,fingerprint) VALUES (?,?,'2026-09-01',-100,'x','expense','manual',?)").run(pid, aid, `f${i}`)
    raw.close()

    const r = h.backupNow()
    expect(fs.existsSync(r.file)).toBe(true)
    expect(path.dirname(r.file)).toBe(path.join(dir, 'backups'))
    const copy = new Database(r.file, { readonly: true })
    expect((copy.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n).toBe(50)
    expect(copy.pragma('user_version', { simple: true })).toBe(1)
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
    copy.close()
    expect(h.diagnostics().transactions).toBe(50) // original untouched
    h.close()
  })

  it('two backups in a row make two files', () => {
    const dir = tmp()
    const h = createHandlers(path.join(dir, 'finance.db'))
    h.status()
    const a = h.backupNow().file
    const b = h.backupNow().file
    expect(a).not.toBe(b)
    h.close()
  })
})
