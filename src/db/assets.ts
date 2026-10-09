// Things the person owns that are not in an account (a house, a car, stocks held elsewhere...), so net worth is the whole picture.
// Each has a value "as of" a date and a history of earlier values, like a loan's balance.
import type { Db } from './open'

export type AssetKind = 'property' | 'vehicle' | 'investment' | 'other'
export const ASSET_KINDS: AssetKind[] = ['property', 'vehicle', 'investment', 'other']
const iso = /^\d{4}-\d{2}-\d{2}$/

export interface AssetRow { id: number; profileId: number; owner: string; name: string; kind: AssetKind; valueCents: number; asOf: string; notes: string | null; /** Change since the value before this one, or null with only one value on record. */ changeCents: number | null }
export interface NewAsset { name: string; kind: AssetKind; valueCents: number; asOf: string; notes?: string }

function mine(db: Db, profileId: number, id: number) {
  const a = db.prepare('SELECT id, profile_id AS p, value_cents AS v, as_of AS asOf FROM asset WHERE id = ?').get(id) as { id: number; p: number; v: number; asOf: string } | undefined
  if (!a || a.p !== profileId) throw new Error('That item no longer exists. Reload the page.')
  return a
}

function checkValue(valueCents: number, asOf: string) {
  if (!Number.isInteger(valueCents) || valueCents < 0) throw new Error('The value cannot be negative.')
  if (!iso.test(asOf)) throw new Error('The date has to look like 2026-10-09.')
}

export function createAsset(db: Db, profileId: number, a: NewAsset): number {
  const name = a.name.trim()
  if (!name) throw new Error('Give it a name (for example "House" or "Car").')
  if (name.length > 60) throw new Error('That name is too long.')
  if (!ASSET_KINDS.includes(a.kind)) throw new Error('Choose what kind of thing it is.')
  checkValue(a.valueCents, a.asOf)
  if (!db.prepare('SELECT 1 FROM profile WHERE id = ?').get(profileId)) throw new Error('That person no longer exists. Reload the page.')
  if (db.prepare('SELECT 1 FROM asset WHERE profile_id = ? AND name = ? COLLATE NOCASE').get(profileId, name)) throw new Error(`You already have something called "${name}".`)
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO asset (profile_id, name, kind, value_cents, as_of, notes) VALUES (?,?,?,?,?,?)').run(profileId, name, a.kind, a.valueCents, a.asOf, a.notes?.trim() || null).lastInsertRowid)
    db.prepare('INSERT INTO asset_value (asset_id, as_of, value_cents) VALUES (?,?,?)').run(id, a.asOf, a.valueCents)
    return id
  })()
}

/** Records a new value. Earlier values stay in the history; the current value is the one with the latest date. */
export function updateAssetValue(db: Db, profileId: number, id: number, valueCents: number, asOf: string): void {
  const a = mine(db, profileId, id)
  checkValue(valueCents, asOf)
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO asset_value (asset_id, as_of, value_cents) VALUES (?,?,?)').run(id, a.asOf, a.v)
    db.prepare('INSERT INTO asset_value (asset_id, as_of, value_cents) VALUES (?,?,?) ON CONFLICT(asset_id, as_of) DO UPDATE SET value_cents = excluded.value_cents').run(id, asOf, valueCents)
    const latest = db.prepare('SELECT as_of a, value_cents v FROM asset_value WHERE asset_id = ? ORDER BY as_of DESC LIMIT 1').get(id) as { a: string; v: number }
    db.prepare('UPDATE asset SET value_cents = ?, as_of = ? WHERE id = ?').run(latest.v, latest.a, id)
  })()
}

export function updateAsset(db: Db, profileId: number, id: number, patch: { name?: string; kind?: AssetKind; notes?: string | null }): void {
  mine(db, profileId, id)
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('Give it a name.')
    if (db.prepare('SELECT 1 FROM asset WHERE profile_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(profileId, name, id)) throw new Error(`You already have something called "${name}".`)
    db.prepare('UPDATE asset SET name = ? WHERE id = ?').run(name, id)
  }
  if (patch.kind !== undefined) {
    if (!ASSET_KINDS.includes(patch.kind)) throw new Error('Choose what kind of thing it is.')
    db.prepare('UPDATE asset SET kind = ? WHERE id = ?').run(patch.kind, id)
  }
  if (patch.notes !== undefined) db.prepare('UPDATE asset SET notes = ? WHERE id = ?').run(patch.notes?.trim() || null, id)
}

export function deleteAsset(db: Db, profileId: number, id: number): void {
  mine(db, profileId, id)
  db.prepare('DELETE FROM asset WHERE id = ?').run(id) // its history goes with it
}

export function assetHistory(db: Db, profileId: number, id: number): { asOf: string; valueCents: number }[] {
  mine(db, profileId, id)
  return db.prepare('SELECT as_of AS asOf, value_cents AS valueCents FROM asset_value WHERE asset_id = ? ORDER BY as_of').all(id) as { asOf: string; valueCents: number }[]
}

export function listAssets(db: Db, profileIds: number[]): AssetRow[] {
  if (profileIds.length === 0) return []
  const rows = db.prepare(`SELECT a.id, a.profile_id AS profileId, p.name AS owner, a.name, a.kind, a.value_cents AS valueCents, a.as_of AS asOf, a.notes,
      (SELECT v.value_cents FROM asset_value v WHERE v.asset_id = a.id AND v.as_of < a.as_of ORDER BY v.as_of DESC LIMIT 1) AS before
    FROM asset a JOIN profile p ON p.id = a.profile_id WHERE a.profile_id IN (${profileIds.map(() => '?').join(',')}) ORDER BY a.value_cents DESC, a.name`).all(...profileIds) as (Omit<AssetRow, 'changeCents'> & { before: number | null })[]
  return rows.map(({ before, ...r }) => ({ ...r, changeCents: before === null ? null : r.valueCents - before }))
}

export interface NetWorth {
  /** Money in chequing, savings, cash and valued investment accounts. */
  accountsCents: number
  /** What is owed on credit cards and loan accounts (a positive number). */
  cardsOwedCents: number
  /** Personal debts you track by hand (student loans...). */
  debtsCents: number
  /** Houses, cars and other things you added. */
  assetsCents: number
  netWorthCents: number
}

/** Everything owned minus everything owed, for these people (one person, or everybody and the shared accounts for the household view). */
export function netWorth(db: Db, profileIds: number[]): NetWorth {
  if (profileIds.length === 0) return { accountsCents: 0, cardsOwedCents: 0, debtsCents: 0, assetsCents: 0, netWorthCents: 0 }
  const marks = profileIds.map(() => '?').join(',')
  // an account's value: investments are the latest value typed in; everything else is its starting balance plus its transactions
  const accounts = db.prepare(`SELECT a.type, CASE WHEN a.type = 'investment' THEN COALESCE((SELECT value_cents FROM account_valuation v WHERE v.account_id = a.id ORDER BY v.as_of DESC LIMIT 1), 0)
      ELSE a.opening_balance_cents + COALESCE((SELECT SUM(amount_cents) FROM txn t WHERE t.account_id = a.id), 0) END AS v
    FROM account a WHERE a.profile_id IN (${marks}) AND a.archived = 0`).all(...profileIds) as { type: string; v: number }[]
  let accountsCents = 0, cardsOwedCents = 0
  for (const a of accounts) {
    if (a.type === 'credit_card' || a.type === 'loan') cardsOwedCents += Math.max(0, -a.v)
    else accountsCents += a.v
  }
  const debtsCents = (db.prepare(`SELECT COALESCE(SUM(balance_cents), 0) s FROM debt WHERE profile_id IN (${marks})`).get(...profileIds) as { s: number }).s
  const assetsCents = (db.prepare(`SELECT COALESCE(SUM(value_cents), 0) s FROM asset WHERE profile_id IN (${marks})`).get(...profileIds) as { s: number }).s
  return { accountsCents, cardsOwedCents, debtsCents, assetsCents, netWorthCents: accountsCents + assetsCents - cardsOwedCents - debtsCents }
}
