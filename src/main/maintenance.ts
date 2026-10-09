// File-level housekeeping for the database: daily automatic backups and erasing the data. Kept apart from handlers.ts so
// it can be tested on its own with a temporary folder.
import fs from 'node:fs'
import path from 'node:path'

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

/** Deletes the database file and its journal files. */
export function removeDatabaseFiles(dbFile: string): void {
  if (dbFile === ':memory:') return
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true })
}
