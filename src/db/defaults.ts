import type { Db } from './open'

/** Starter categories every new profile gets. The names line up with the built-in keyword rules used when importing. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  'Groceries', 'Dining', 'Transportation', 'Rent & housing', 'Utilities', 'Subscriptions', 'Shopping', 'Health & personal care',
  'Entertainment', 'Travel', 'Insurance, loans & admin', 'Bank fees & interest', 'Gifts', 'Other'
]
export const DEFAULT_INCOME_CATEGORIES = ['Pay', 'Interest', 'Gifts received', 'Other income']

export function seedCategories(db: Db, profileId: number): void {
  const add = db.prepare('INSERT OR IGNORE INTO category (profile_id, name, kind) VALUES (?,?,?)')
  for (const n of DEFAULT_EXPENSE_CATEGORIES) add.run(profileId, n, 'expense')
  for (const n of DEFAULT_INCOME_CATEGORIES) add.run(profileId, n, 'income')
}

export type AppMode = 'single' | 'couple' | 'couple_household'
export const APP_MODES: AppMode[] = ['single', 'couple', 'couple_household']

export interface NewPerson { name: string; accounts: { name: string; type: 'chequing' | 'savings' | 'credit_card' | 'investment' | 'other' }[] }

const slugOf = (name: string, taken: Set<string>) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person'
  let slug = base
  for (let i = 2; taken.has(slug) || slug === 'household'; i++) slug = `${base}-${i}`
  taken.add(slug)
  return slug
}

/**
 * Creates the people for the chosen setup, each with starter categories, a Cash wallet and the accounts they listed.
 * single: one person. couple: two people. couple_household: two people plus a shared "Household" profile.
 */
export function createSetup(db: Db, mode: AppMode, people: NewPerson[]): number[] {
  if (!APP_MODES.includes(mode)) throw new Error('Choose one of the three setups.')
  const expected = mode === 'single' ? 1 : 2
  if (people.length !== expected) throw new Error(mode === 'single' ? 'Enter one name' : 'Enter both names')
  if (db.prepare("SELECT 1 FROM profile WHERE kind = 'person'").get()) throw new Error('This app already has data.')
  const names = people.map((p) => p.name.trim())
  if (names.some((n) => !n)) throw new Error('Everyone needs a name')
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new Error('The two names must be different')
  const taken = new Set<string>()
  const ids: number[] = []
  db.transaction(() => {
    people.forEach((p, i) => {
      const id = Number(db.prepare("INSERT INTO profile (slug, name, kind) VALUES (?,?,'person')").run(slugOf(names[i]!, taken), names[i]).lastInsertRowid)
      seedCategories(db, id)
      db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Cash', 'cash')").run(id)
      const seen = new Set<string>(['cash'])
      for (const a of p.accounts) {
        const n = a.name.trim()
        if (!n || seen.has(n.toLowerCase())) continue
        seen.add(n.toLowerCase())
        db.prepare('INSERT INTO account (profile_id, name, type) VALUES (?,?,?)').run(id, n, a.type)
      }
      ids.push(id)
    })
    db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('app_mode', mode)
  })()
  return ids
}

export function getAppMode(db: Db): AppMode {
  const v = (db.prepare("SELECT value FROM setting WHERE key = 'app_mode'").get() as { value: string } | undefined)?.value
  return APP_MODES.includes(v as AppMode) ? (v as AppMode) : 'single'
}
