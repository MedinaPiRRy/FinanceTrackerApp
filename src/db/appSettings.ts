// General preferences kept in the database's `setting` table (so they travel with a backup).
import type { Db } from './open'

export const OLDER_CHOICES = [30, 90, 180, 365] as const
export const BACKUP_CHOICES = [0, 5, 10, 20] as const
export const START_PAGES = ['dashboard', 'monthly', 'transactions', 'review', 'accounts', 'budget', 'forecast'] as const
export type StartPage = (typeof START_PAGES)[number]

export interface AppSettings {
  /** A waiting transaction older than this many days is set aside in Review's Older tab. */
  olderAfterDays: number
  startPage: StartPage
  /** Automatic backups kept (0 = off). One is made the first time the app opens each day. */
  autoBackupKeep: number
}

export const DEFAULT_SETTINGS: AppSettings = { olderAfterDays: 90, startPage: 'dashboard', autoBackupKeep: 0 }

const read = (db: Db, key: string): string | undefined => (db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined)?.value
const write = (db: Db, key: string, value: string) => db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

export function getAppSettings(db: Db): AppSettings {
  const days = Number(read(db, 'older_after_days'))
  const keep = Number(read(db, 'auto_backup_keep'))
  const page = read(db, 'start_page')
  return {
    olderAfterDays: (OLDER_CHOICES as readonly number[]).includes(days) ? days : DEFAULT_SETTINGS.olderAfterDays,
    startPage: (START_PAGES as readonly string[]).includes(page ?? '') ? (page as StartPage) : DEFAULT_SETTINGS.startPage,
    autoBackupKeep: (BACKUP_CHOICES as readonly number[]).includes(keep) ? keep : DEFAULT_SETTINGS.autoBackupKeep
  }
}

export const olderAfterDays = (db: Db): number => getAppSettings(db).olderAfterDays

export function setAppSetting<K extends keyof AppSettings>(db: Db, key: K, value: AppSettings[K]): AppSettings {
  if (key === 'olderAfterDays') {
    if (!(OLDER_CHOICES as readonly number[]).includes(value as number)) throw new Error('Choose 30, 90, 180 or 365 days.')
    write(db, 'older_after_days', String(value))
  } else if (key === 'startPage') {
    if (!(START_PAGES as readonly string[]).includes(value as string)) throw new Error('Choose a page from the list.')
    write(db, 'start_page', String(value))
  } else if (key === 'autoBackupKeep') {
    if (!(BACKUP_CHOICES as readonly number[]).includes(value as number)) throw new Error('Choose off, 5, 10 or 20 backups.')
    write(db, 'auto_backup_keep', String(value))
  } else throw new Error('Unknown setting')
  return getAppSettings(db)
}
