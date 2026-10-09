// Changing the setup after the first run: add the partner, add the shared household, or take either away again.
// Adding never touches existing data. Removing deletes that person's (or the household's) data for good, so the caller
// makes a backup first and asks the person to type a confirmation.
import type { Db } from './open'
import { ensureHouseholdProfile } from './open'
import { getAppMode, seedCategories, type AppMode, type NewPerson } from './defaults'

const setMode = (db: Db, mode: AppMode) => db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('app_mode', mode)

function slugFor(db: Db, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person'
  const taken = new Set((db.prepare('SELECT slug FROM profile').all() as { slug: string }[]).map((r) => r.slug))
  let slug = base
  for (let i = 2; taken.has(slug) || slug === 'household'; i++) slug = `${base}-${i}`
  return slug
}

/** Just me -> me and my partner. The partner starts with their own categories, a Cash wallet and the accounts listed. */
export function addPartner(db: Db, person: NewPerson): number {
  if (getAppMode(db) !== 'single') throw new Error('Your setup already has a partner.')
  const name = person.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Enter your partner’s name')
  if (name.length > 40) throw new Error('That name is too long (40 characters at most)')
  if (/^household$/i.test(name)) throw new Error('"Household" is the name of the shared view. Choose another name.')
  if (db.prepare("SELECT 1 FROM profile WHERE kind = 'person' AND name = ? COLLATE NOCASE").get(name)) throw new Error('The two names must be different')
  return db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO profile (slug, name, kind) VALUES (?,?,'person')").run(slugFor(db, name), name).lastInsertRowid)
    seedCategories(db, id)
    db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Cash', 'cash')").run(id)
    const seen = new Set<string>(['cash'])
    for (const a of person.accounts) {
      const n = a.name.trim()
      if (!n || seen.has(n.toLowerCase())) continue
      seen.add(n.toLowerCase())
      db.prepare('INSERT INTO account (profile_id, name, type) VALUES (?,?,?)').run(id, n, a.type)
    }
    setMode(db, 'couple')
    return id
  })()
}

/** Me and my partner -> plus a shared household (shared accounts, household budgets and goals). */
export function addHousehold(db: Db): number {
  if (getAppMode(db) !== 'couple') throw new Error(getAppMode(db) === 'single' ? 'Add your partner first.' : 'Your setup already has a shared household.')
  return db.transaction(() => {
    const id = ensureHouseholdProfile(db)
    setMode(db, 'couple_household')
    return id
  })()
}

/**
 * Deletes everything that belongs to one profile (a person or the household). Money that moved between that profile and
 * somebody else becomes "needs review" on the other side, so no figure silently changes meaning.
 */
export function deleteProfileData(db: Db, profileId: number, alsoInTransaction?: () => void): void {
  if (!db.prepare('SELECT 1 FROM profile WHERE id = ?').get(profileId)) throw new Error('That person no longer exists. Reload the page.')
  db.pragma('foreign_keys = OFF') // tables are emptied in any order; checked again below
  try {
    db.transaction(() => {
      db.prepare("UPDATE txn SET kind = 'unclassified', category_id = NULL, transfer_group = NULL, counterparty_profile_id = NULL, review_reason = 'The other person or the shared household was removed. What was this money?' WHERE counterparty_profile_id = ? AND profile_id <> ?").run(profileId, profileId)
      const accounts = `(SELECT id FROM account WHERE profile_id = ${profileId})`
      db.exec(`
        DELETE FROM account_valuation WHERE account_id IN ${accounts};
        DELETE FROM debt_terms WHERE (kind = 'card' AND ref_id IN ${accounts}) OR (kind = 'loan' AND ref_id IN (SELECT id FROM debt WHERE profile_id = ${profileId}));
        DELETE FROM debt_history WHERE debt_id IN (SELECT id FROM debt WHERE profile_id = ${profileId});
        DELETE FROM goal_debt WHERE goal_id IN (SELECT id FROM goal WHERE profile_id = ${profileId});
        DELETE FROM budget_category WHERE budget_id IN (SELECT id FROM budget WHERE profile_id = ${profileId});
      `)
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'profile'").all() as { name: string }[]).map((t) => t.name)
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]
        if (cols.some((c) => c.name === 'profile_id')) db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(profileId)
      }
      for (const prefix of ['debt_plan_', 'forecast_whatif_', 'import_last_account_', 'partner_aliases_']) db.prepare('DELETE FROM setting WHERE key = ?').run(`${prefix}${profileId}`)
      db.prepare('DELETE FROM profile WHERE id = ?').run(profileId)
      alsoInTransaction?.()
    })()
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Removing that data would leave inconsistent records, so nothing was removed.')
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

/** Removes the shared household and everything in it (shared accounts, their transactions, household budgets and goals). */
export function removeHousehold(db: Db, confirm: string): void {
  if (getAppMode(db) !== 'couple_household') throw new Error('There is no shared household to remove.')
  if (confirm.trim() !== 'REMOVE') throw new Error('Type REMOVE to confirm.')
  const hh = db.prepare("SELECT id FROM profile WHERE kind = 'household'").get() as { id: number } | undefined
  const finish = () => { db.exec('DELETE FROM household_budget_group; DELETE FROM household_budget;'); setMode(db, 'couple') }
  if (hh) deleteProfileData(db, hh.id, finish)
  else db.transaction(finish)()
}

/** Removes one of the two people and all of their data, leaving a "just me" setup. The shared household has to be removed first. */
export function removePartner(db: Db, partnerId: number, confirmName: string): void {
  const mode = getAppMode(db)
  if (mode === 'single') throw new Error('There is no partner to remove.')
  if (mode === 'couple_household') throw new Error('Remove the shared household first, then the partner.')
  const p = db.prepare("SELECT id, name FROM profile WHERE id = ? AND kind = 'person'").get(partnerId) as { id: number; name: string } | undefined
  if (!p) throw new Error('That person no longer exists. Reload the page.')
  if (confirmName.trim() !== p.name) throw new Error(`Type ${p.name}’s name exactly to confirm.`)
  deleteProfileData(db, p.id, () => setMode(db, 'single'))
}
