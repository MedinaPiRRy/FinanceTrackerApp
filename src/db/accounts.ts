import type { Db } from './open'
import { accountValueCents } from './review'

export type AccountType = 'chequing' | 'savings' | 'credit_card' | 'cash' | 'investment' | 'loan' | 'other'
const TYPES: AccountType[] = ['chequing', 'savings', 'credit_card', 'cash', 'investment', 'loan', 'other']
const iso = /^\d{4}-\d{2}-\d{2}$/

export interface NewAccount {
  name: string
  type: AccountType
  institution?: string
  /** For credit cards and loans: how much is owed right now (a positive number). For everything else: the balance. */
  openingCents?: number
  creditLimitCents?: number | null
}

function ownedAccount(db: Db, profileId: number, id: number) {
  const a = db.prepare('SELECT id, name, type, profile_id AS p, archived FROM account WHERE id = ?').get(id) as { id: number; name: string; type: string; p: number; archived: number } | undefined
  if (!a || a.p !== profileId) throw new Error('That account no longer exists. Reload the page.')
  return a
}

export function createAccount(db: Db, profileId: number, a: NewAccount): number {
  const name = a.name.trim()
  if (!name) throw new Error('Give the account a name')
  if (!TYPES.includes(a.type)) throw new Error('Choose an account type from the list.')
  if (a.type === 'cash') throw new Error('Each person already has one Cash wallet')
  if (a.openingCents !== undefined && (!Number.isInteger(a.openingCents) || a.openingCents < 0)) throw new Error('The starting amount cannot be negative')
  if (a.creditLimitCents != null && (!Number.isInteger(a.creditLimitCents) || a.creditLimitCents < 0)) throw new Error('The credit limit cannot be negative')
  if (!db.prepare('SELECT 1 FROM profile WHERE id = ?').get(profileId)) throw new Error('That person no longer exists. Reload the page.')
  if (db.prepare('SELECT 1 FROM account WHERE profile_id = ? AND name = ? COLLATE NOCASE').get(profileId, name)) throw new Error(`There is already an account called "${name}"`)
  const opening = a.type === 'credit_card' || a.type === 'loan' ? -(a.openingCents ?? 0) : a.openingCents ?? 0 // debts are stored negative
  return Number(
    db.prepare('INSERT INTO account (profile_id, name, type, institution, opening_balance_cents, credit_limit_cents) VALUES (?,?,?,?,?,?)')
      .run(profileId, name, a.type, a.institution?.trim() || null, opening, a.creditLimitCents ?? null).lastInsertRowid
  )
}

/** Sets or clears a credit card's limit. */
export function setCreditLimit(db: Db, profileId: number, id: number, limitCents: number | null): void {
  const a = ownedAccount(db, profileId, id)
  if (a.type !== 'credit_card') throw new Error('Only credit cards have a limit.')
  if (limitCents !== null && (!Number.isInteger(limitCents) || limitCents <= 0)) throw new Error('Enter the limit as an amount greater than zero, or leave it empty to remove it.')
  db.prepare('UPDATE account SET credit_limit_cents = ? WHERE id = ?').run(limitCents, id)
}

export function renameAccount(db: Db, profileId: number, id: number, name: string): void {
  ownedAccount(db, profileId, id)
  const clean = name.trim()
  if (!clean) throw new Error('Give the account a name')
  if (db.prepare('SELECT 1 FROM account WHERE profile_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(profileId, clean, id)) throw new Error(`There is already an account called "${clean}"`)
  db.prepare('UPDATE account SET name = ? WHERE id = ?').run(clean, id)
}

/**
 * Closing hides an account from pickers and totals; the history stays. An account that still has money in it (or owes
 * money) is only closed when the caller confirms, so a balance never silently disappears from the totals.
 */
export function closeAccount(db: Db, profileId: number, id: number, opts: { confirmBalance?: boolean } = {}): { closed: boolean; balanceCents: number | null } {
  const a = ownedAccount(db, profileId, id)
  if (a.type === 'cash') throw new Error('The Cash wallet cannot be closed')
  const bal = accountValueCents(db, id)
  if (bal !== null && bal !== 0 && !opts.confirmBalance) return { closed: false, balanceCents: bal }
  db.prepare('UPDATE account SET archived = 1 WHERE id = ?').run(id)
  return { closed: true, balanceCents: bal }
}

export function reopenAccount(db: Db, profileId: number, id: number): void {
  ownedAccount(db, profileId, id)
  db.prepare('UPDATE account SET archived = 0 WHERE id = ?').run(id)
}

/**
 * Gives an account (and all its transactions) to another profile: to the household to make it shared, or back to a person.
 * Categories are matched by name in the new owner's list and created there if missing. Refused while something in the
 * old profile still depends on the account (a goal or a recurring bill), with a message saying what.
 */
export function moveAccount(db: Db, accountId: number, toProfileId: number): { movedTransactions: number; createdCategories: number } {
  const a = db.prepare('SELECT id, name, type, profile_id AS p FROM account WHERE id = ?').get(accountId) as { id: number; name: string; type: string; p: number } | undefined
  if (!a) throw new Error('That account no longer exists. Reload the page.')
  if (!db.prepare('SELECT 1 FROM profile WHERE id = ?').get(toProfileId)) throw new Error('That person no longer exists. Reload the page.')
  if (a.p === toProfileId) throw new Error('The account already belongs there')
  if (a.type === 'cash') throw new Error('A Cash wallet belongs to one person and cannot be moved')
  if (db.prepare('SELECT 1 FROM account WHERE profile_id = ? AND name = ? COLLATE NOCASE').get(toProfileId, a.name)) throw new Error(`There is already an account called "${a.name}" there. Rename one first.`)

  const goals = db.prepare('SELECT g.name FROM goal g WHERE g.account_id = ? UNION SELECT g.name FROM goal g JOIN goal_debt d ON d.goal_id = g.id WHERE d.account_id = ?').all(accountId, accountId) as { name: string }[]
  if (goals.length) throw new Error(`The goal "${goals[0]!.name}" uses this account. Edit or delete that goal first.`)
  const rec = db.prepare('SELECT name FROM recurring WHERE account_id = ?').all(accountId) as { name: string }[]
  if (rec.length) throw new Error(`The recurring item "${rec[0]!.name}" is paid from this account. Remove it from Recurring first.`)

  let created = 0
  const moved = db.transaction(() => {
    const catFor = new Map<number, number | null>()
    const mapCategory = (oldId: number | null): number | null => {
      if (oldId === null) return null
      if (catFor.has(oldId)) return catFor.get(oldId)!
      const c = db.prepare('SELECT name, kind, group_name AS g FROM category WHERE id = ?').get(oldId) as { name: string; kind: string; g: string | null }
      let hit = db.prepare('SELECT id FROM category WHERE profile_id = ? AND kind = ? AND name = ? COLLATE NOCASE').get(toProfileId, c.kind, c.name) as { id: number } | undefined
      if (!hit) {
        hit = { id: Number(db.prepare('INSERT INTO category (profile_id, name, kind, group_name) VALUES (?,?,?,?)').run(toProfileId, c.name, c.kind, c.g).lastInsertRowid) }
        created++
      }
      catFor.set(oldId, hit.id)
      return hit.id
    }
    const rows = db.prepare('SELECT id, category_id AS c FROM txn WHERE account_id = ?').all(accountId) as { id: number; c: number | null }[]
    const upd = db.prepare('UPDATE txn SET profile_id = ?, category_id = ? WHERE id = ?')
    for (const r of rows) upd.run(toProfileId, mapCategory(r.c), r.id)
    // import batches that only ever contained this account follow it
    const batches = db.prepare('SELECT DISTINCT import_batch_id b FROM txn WHERE account_id = ? AND import_batch_id IS NOT NULL').all(accountId) as { b: number }[]
    for (const { b } of batches) {
      const other = db.prepare('SELECT 1 FROM txn WHERE import_batch_id = ? AND account_id <> ?').get(b, accountId)
      if (!other) db.prepare('UPDATE import_batch SET profile_id = ? WHERE id = ?').run(toProfileId, b)
    }
    db.prepare('UPDATE account SET profile_id = ? WHERE id = ?').run(toProfileId, accountId)
    return rows.length
  })()
  return { movedTransactions: moved, createdCategories: created }
}

/** Edits an account's name, bank/institution and (for credit cards) limit in one step. Only the fields given are changed. */
export function updateAccount(db: Db, profileId: number, id: number, patch: { name?: string; institution?: string | null; creditLimitCents?: number | null }): void {
  const a = ownedAccount(db, profileId, id)
  db.transaction(() => {
    if (patch.name !== undefined && patch.name.trim() !== a.name) renameAccount(db, profileId, id, patch.name)
    if (patch.institution !== undefined) {
      const inst = patch.institution?.trim() || null
      if (inst && inst.length > 60) throw new Error('The institution name is too long')
      db.prepare('UPDATE account SET institution = ? WHERE id = ?').run(inst, id)
    }
    if (patch.creditLimitCents !== undefined) {
      if (a.type !== 'credit_card' && patch.creditLimitCents !== null) throw new Error('Only credit cards have a limit.')
      if (a.type === 'credit_card') setCreditLimit(db, profileId, id, patch.creditLimitCents)
    }
  })()
}

export interface DeleteAccountOptions {
  /** Give the account's transactions to this other account of the same person. */
  moveToAccountId?: number
  /** Delete the transactions together with the account (needs `confirmName`). */
  deleteTransactions?: boolean
  /** The account's name, typed by the person, to confirm deleting its transactions. */
  confirmName?: string
}

/**
 * Deletes an account. An empty one is simply removed. One with transactions needs a decision: move them to another of the
 * person's accounts, or delete them with it (the person types the account's name). Refused while a goal or a recurring bill
 * still uses the account, saying which. The caller makes a backup first.
 */
export function deleteAccount(db: Db, profileId: number, id: number, opts: DeleteAccountOptions = {}): { movedTransactions: number; deletedTransactions: number } {
  const a = ownedAccount(db, profileId, id)
  if (a.type === 'cash') throw new Error('The Cash wallet cannot be deleted')
  const goal = db.prepare('SELECT g.name FROM goal g WHERE g.account_id = ? UNION SELECT g.name FROM goal g JOIN goal_debt d ON d.goal_id = g.id WHERE d.account_id = ?').get(id, id) as { name: string } | undefined
  if (goal) throw new Error(`The goal "${goal.name}" uses this account. Edit or delete that goal first.`)
  const rec = db.prepare('SELECT name FROM recurring WHERE account_id = ?').get(id) as { name: string } | undefined
  if (rec) throw new Error(`The recurring item "${rec.name}" is paid from this account. Remove it from Recurring first.`)

  const count = (db.prepare('SELECT COUNT(*) n FROM txn WHERE account_id = ?').get(id) as { n: number }).n
  let target: { id: number; type: string } | null = null
  if (count > 0) {
    if (opts.moveToAccountId !== undefined) {
      target = db.prepare('SELECT id, type, profile_id AS p FROM account WHERE id = ?').get(opts.moveToAccountId) as { id: number; type: string; p: number } | null
      if (!target || (target as unknown as { p: number }).p !== profileId) throw new Error('Pick one of your own accounts to move the transactions to.')
      if (target.id === id) throw new Error('Pick a different account to move the transactions to.')
      if (target.type === 'investment') throw new Error('Investment accounts have no transactions. Pick another account.')
    } else if (opts.deleteTransactions) {
      if ((opts.confirmName ?? '').trim() !== a.name) throw new Error(`Type the account name exactly ("${a.name}") to delete its ${count.toLocaleString()} transactions.`)
    } else {
      throw new Error(`This account has ${count.toLocaleString()} transactions. Choose to move them to another account, or delete them with it.`)
    }
  }

  let moved = 0
  let deleted = 0
  // newer databases record which account a batch was for; older ones do not
  const batchHasAccount = (db.prepare('PRAGMA table_info(import_batch)').all() as { name: string }[]).some((c) => c.name === 'account_id')
  const batches = (db.prepare('SELECT DISTINCT import_batch_id b FROM txn WHERE account_id = ? AND import_batch_id IS NOT NULL').all(id) as { b: number }[]).map((r) => r.b)
  db.transaction(() => {
    if (target) {
      moved = db.prepare('UPDATE txn SET account_id = ? WHERE account_id = ?').run(target.id, id).changes
      if (batchHasAccount) db.prepare('UPDATE import_batch SET account_id = ? WHERE account_id = ?').run(target.id, id)
    } else if (count > 0) {
      const groups = db.prepare('SELECT DISTINCT transfer_group g FROM txn WHERE account_id = ? AND transfer_group IS NOT NULL').all(id) as { g: string }[]
      deleted = db.prepare('DELETE FROM txn WHERE account_id = ?').run(id).changes
      // a transfer whose other half was just deleted becomes unlinked
      for (const { g } of groups) db.prepare('UPDATE txn SET transfer_group = NULL WHERE transfer_group = ? AND (SELECT COUNT(*) FROM txn WHERE transfer_group = ?) < 2').run(g, g)
    }
    // import batches that were only ever for this account go with its transactions
    if (!target) for (const b of batches) db.prepare('DELETE FROM import_batch WHERE id = ? AND NOT EXISTS (SELECT 1 FROM txn WHERE import_batch_id = ?)').run(b, b)
    db.prepare('DELETE FROM account_valuation WHERE account_id = ?').run(id)
    db.prepare("DELETE FROM debt_terms WHERE kind = 'card' AND ref_id = ?").run(id)
    db.prepare('DELETE FROM setting WHERE key = ?').run(`import_last_account_${profileId}`)
    db.prepare('DELETE FROM account WHERE id = ?').run(id)
  })()
  return { movedTransactions: moved, deletedTransactions: deleted }
}
