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
  try {
    return initDb(db, file)
  } catch (e) {
    db.close() // a refused or failed upgrade must not leave the file open (it could not be erased or replaced while open)
    throw e
  }
}

/** Upgrade copies (finance.db.bak-v<N>-<time>) hold a full copy of the data each; only the newest few are kept. */
export function pruneUpgradeCopies(file: string, keep: number): void {
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.bak-`
  const copies = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort((x, y) => fs.statSync(path.join(dir, x)).mtimeMs - fs.statSync(path.join(dir, y)).mtimeMs) // oldest first
  for (const f of copies.slice(0, Math.max(0, copies.length - keep))) fs.rmSync(path.join(dir, f), { force: true })
}

function initDb(db: Db, file: string): Db {
  registerFold(db)
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
      pruneUpgradeCopies(file, 3)
    }
    while (version < SCHEMA_VERSION) {
      const next = version + 1
      const m = MIGRATIONS[next]
      if (!m) throw new Error(`No migration from schema v${version} to v${next}.`)
      db.pragma('foreign_keys = OFF') // tables are dropped and recreated; checked before each step is committed
      try { db.transaction(() => {
        for (const t of m.guard) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
          if (n > 0) throw new Error(`Upgrade stopped: table "${t}" contains ${n} rows and would be dropped. Nothing was changed.`)
        }
        db.exec(m.sql)
        db.pragma(`user_version = ${next}`)
        // checked before the upgrade is committed, so inconsistent data rolls the whole step back and the version number stays where it was
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Upgrade left inconsistent data, so it was undone and nothing was changed. The backup copy was kept.')
      })() } finally { db.pragma('foreign_keys = ON') }
      version = next
    }
  }
  return db
}

/**
 * `fold(text)`: lower case with accents removed ("CAFÉ" and "Café" and "cafe" are one name). SQLite's own NOCASE only folds A-Z, so every
 * "is this name taken" check uses this instead.
 */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}
function registerFold(db: Db) {
  db.function('fold', { deterministic: true }, (v) => (v === null || v === undefined ? null : foldName(String(v))))
}

/** The household pseudo-profile owns shared accounts. Created only when the user chooses the household setup. */
export function ensureHouseholdProfile(db: Db): number {
  const row = db.prepare("SELECT id FROM profile WHERE kind = 'household'").get() as { id: number } | undefined
  if (row) return row.id
  const id = Number(db.prepare("INSERT INTO profile (slug, name, kind) VALUES ('household', 'Household', 'household')").run().lastInsertRowid)
  seedCategories(db, id)
  return id
}
