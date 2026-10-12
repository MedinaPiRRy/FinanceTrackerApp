// File-level housekeeping for the database: daily automatic backups and erasing the data. Kept apart from handlers.ts so
// it can be tested on its own with a temporary folder.
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA_VERSION } from '../db/schema'

/** What the installed app (Electron) can do that the browser-based dev server cannot. All optional. */
export interface PlatformHooks {
  /** Closes the app. */
  quit?: () => void
  /** Starts the platform's uninstaller. Returns what happened, in words for the person. */
  startUninstaller?: () => { started: boolean; message: string }
  /** Asks where to save a text file and writes it. Returns the path, or null if the person cancelled. */
  saveTextFile?: (suggestedName: string, content: string) => Promise<string | null>
}

const AUTO = /^auto-\d{4}-\d{2}-\d{2}\.db$/

/**
 * Makes today's automatic backup if there is none yet, then keeps only the newest `keep` automatic backups
 * (backups the person made by hand are never touched). Returns the file made, or null.
 */
export function autoBackupIfDue(dir: string, keep: number, today: string, make: (file: string) => void): string | null {
  if (keep <= 0) return null
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `auto-${today}.db`)
  let made: string | null = null
  if (!fs.existsSync(file)) { make(file); made = file }
  const autos = fs.readdirSync(dir).filter((f) => AUTO.test(f)).sort()
  for (const f of autos.slice(0, Math.max(0, autos.length - keep))) fs.rmSync(path.join(dir, f), { force: true })
  return made
}

/**
 * "Erase all my data": removes everything the app keeps about the person's money, not only the database. That is the database and its journal
 * files, the sample database, the state file, the copies made before upgrades (finance.db.bak-v*), and the backups folder (backups and Excel
 * workbook copies). The one backup the person asked to keep (`keepFile`) is left in place. Returns how many files were removed.
 */
export function eraseDataFiles(dbFile: string, keepFile: string | null = null): number {
  if (dbFile === ':memory:') return 0
  const dir = path.dirname(dbFile)
  const base = path.basename(dbFile)
  let n = 0
  const drop = (f: string) => { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); n++ } }
  for (const ext of ['', '-wal', '-shm']) drop(dbFile + ext)
  for (const ext of ['', '-wal', '-shm']) drop(path.join(dir, 'sample.db' + ext))
  drop(path.join(dir, 'app-state.json'))
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.startsWith(`${base}.bak-`)) drop(path.join(dir, f))
  fs.rmSync(path.join(dir, 'sample-backups'), { recursive: true, force: true })
  const backups = path.join(dir, 'backups')
  if (fs.existsSync(backups)) {
    for (const f of fs.readdirSync(backups)) {
      const full = path.join(backups, f)
      if (keepFile && path.resolve(full) === path.resolve(keepFile)) continue
      fs.rmSync(full, { recursive: true, force: true }); n++
    }
    if (fs.readdirSync(backups).length === 0) fs.rmSync(backups, { recursive: true, force: true })
  }
  return n
}

/** Deletes the database file and its journal files. */
export function removeDatabaseFiles(dbFile: string): void {
  if (dbFile === ':memory:') return
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true })
}

// ---- backups: listing, pruning and restoring ----

export interface BackupInfo { name: string; kind: 'automatic' | 'manual' | 'before a restore'; sizeBytes: number; madeAt: string }
const BACKUP_NAME = /^(finance|auto|before-restore)-[A-Za-z0-9T:._-]+\.db$/

/** The database backups in the backups folder, newest first (Excel workbook copies kept there are not listed). */
export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).map((name) => {
    const st = fs.statSync(path.join(dir, name))
    return { name, kind: name.startsWith('auto-') ? 'automatic' as const : name.startsWith('before-restore-') ? 'before a restore' as const : 'manual' as const, sizeBytes: st.size, madeAt: st.mtime.toISOString() }
  }).sort((a, b) => b.madeAt.localeCompare(a.madeAt))
}

/** Keeps the newest `keep` files matching `pattern` in `dir`. Used so backups made by hand and Excel workbook copies do not pile up forever. */
export function pruneFiles(dir: string, pattern: RegExp | ((name: string) => boolean), keep: number): void {
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir).filter((f) => (typeof pattern === 'function' ? pattern(f) : pattern.test(f))).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  for (const x of files.slice(Math.max(0, keep))) fs.rmSync(path.join(dir, x.f), { force: true })
}

/** Why a file cannot be restored, or null when it is a healthy database this version of the app can open. */
export function backupProblem(file: string): string | null {
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') return 'That backup is damaged (its integrity check failed).'
    const v = db.pragma('user_version', { simple: true }) as number
    if (v < 1) return 'That file is not a backup made by this app.'
    if (v > SCHEMA_VERSION) return 'That backup was made by a newer version of the app. Update the app first.'
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile'").get()) return 'That file is not a backup made by this app.'
    return null
  } catch { return 'That backup could not be opened.' } finally { db?.close() }
}

/**
 * Puts a backup in place of the current database. The backup must be one of the files listed in the backups folder (a name, never a path) and
 * healthy. The current data is saved first as "before-restore-<time>.db", so a restore can itself be undone. `closeDb` releases the open file.
 */
export function restoreDatabase(backupsDir: string, name: string, target: string, saveCurrent: (file: string) => void, closeDb: () => void): { restored: string; safetyBackup: string } {
  if (!BACKUP_NAME.test(name)) throw new Error('Choose a backup from the list.')
  const source = path.join(backupsDir, name)
  if (!fs.existsSync(source)) throw new Error('That backup no longer exists. Reload the list.')
  const bad = backupProblem(source)
  if (bad) throw new Error(bad)
  const safety = path.join(backupsDir, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  saveCurrent(safety) // if this fails, nothing has been touched
  const staged = `${target}.restoring`
  try { fs.copyFileSync(source, staged) } catch (e) { fs.rmSync(staged, { force: true }); throw e } // nothing has been touched yet if this fails
  closeDb()
  try {
    for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true }) // an old journal must never be applied to the restored file
    fs.renameSync(staged, target) // replaces the current database in one step
  } catch (e) { fs.rmSync(staged, { force: true }); throw e }
  return { restored: name, safetyBackup: path.basename(safety) }
}
