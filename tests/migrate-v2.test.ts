import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db/open'
import { SCHEMA_SQL, SOURCE_RULE_TABLE, FEATURE_TABLES } from '../src/db/schema'

describe('upgrade from release 1.0.0 / 1.1.0 (schema 1)', () => {
  it('adds the remembered-sources table, keeps every row, and backs the file up first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mig-'))
    const file = path.join(dir, 'finance.db')
    const old = new Database(file)
    old.exec(SCHEMA_SQL.replace(FEATURE_TABLES, '').replace(SOURCE_RULE_TABLE, ''))
    old.pragma('user_version = 1')
    old.prepare("INSERT INTO profile (slug,name) VALUES ('sam','Sam')").run()
    old.prepare("INSERT INTO account (profile_id,name,type) VALUES (1,'Chequing','chequing')").run()
    old.prepare("INSERT INTO txn (profile_id,account_id,posted_date,amount_cents,description,kind,source,fingerprint) VALUES (1,1,'2026-09-01',-500,'Coffee','expense','manual','fp1')").run()
    old.close()

    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    expect((db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM source_rule').get()).toEqual({ n: 0 })
    expect(fs.readdirSync(dir).some((f) => f.startsWith('finance.db.bak-v1-'))).toBe(true)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
