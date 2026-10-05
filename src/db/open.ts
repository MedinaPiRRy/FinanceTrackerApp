import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from './schema'
import { seedCategories } from './defaults'

export type Db = Database.Database

/** Same folder Electron's userData uses (app name "FinanceTracker"): the per-user application-data folder of each OS. */
export function defaultDataDir(): string {
  const home = os.homedir()
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  return path.join(base, 'FinanceTracker')
}
export const defaultDbPath = (): string => path.join(defaultDataDir(), 'finance.db')

/**
 * Opens (and if needed creates or upgrades) the database. Before any upgrade the whole file is copied next to it
 * as finance.db.bak-v<old>-<timestamp>, and an upgrade that would drop tables containing data is refused.
 */
export function openDb(file: string = defaultDbPath()): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  let version = db.pragma('user_version', { simple: true }) as number
  if (version === 0) {
    db.exec(SCHEMA_SQL)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    return db
  }
  if (version > SCHEMA_VERSION) throw new Error(`This database was made by a newer version of the app (schema v${version}, this build understands v${SCHEMA_VERSION}).`)
  if (version < SCHEMA_VERSION) {
    if (file !== ':memory:') {
      db.pragma('wal_checkpoint(TRUNCATE)')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(file, `${file}.bak-v${version}-${stamp}`)
    }
    while (version < SCHEMA_VERSION) {
      const next = version + 1
      const m = MIGRATIONS[next]
      if (!m) throw new Error(`No migration from schema v${version} to v${next}.`)
      db.pragma('foreign_keys = OFF') // tables are dropped and recreated; checked again below
      db.transaction(() => {
        for (const t of m.guard) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
          if (n > 0) throw new Error(`Upgrade stopped: table "${t}" contains ${n} rows and would be dropped. Nothing was changed.`)
        }
        db.exec(m.sql)
        db.pragma(`user_version = ${next}`)
      })()
      const bad = db.pragma('foreign_key_check') as unknown[]
      if (bad.length) throw new Error('Upgrade left inconsistent data; the backup copy was kept.')
      db.pragma('foreign_keys = ON')
      version = next
    }
  }
  return db
}

/** The household pseudo-profile owns shared accounts. Created only when the user chooses the household setup. */
export function ensureHouseholdProfile(db: Db): number {
  const row = db.prepare("SELECT id FROM profile WHERE kind = 'household'").get() as { id: number } | undefined
  if (row) return row.id
  const id = Number(db.prepare("INSERT INTO profile (slug, name, kind) VALUES ('household', 'Household', 'household')").run().lastInsertRowid)
  seedCategories(db, id)
  return id
}
