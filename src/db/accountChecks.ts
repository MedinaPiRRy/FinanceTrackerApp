// Two checks for accounts whose history was imported from several places:
//  1. "Match my bank balance": the balance the app shows is  starting balance + every transaction.  When the history is complete
//     the starting balance is what the account held before its first transaction; this sets it so today's balance agrees with the bank.
//  2. "Same transactions in two accounts": a file imported into the wrong account (or a workbook and a statement that both include the
//     same card) puts every purchase in two accounts. A purchase cannot be on two cards, so the copies are found and can be removed.
import type { Db } from './open'
import { accountValueCents } from './review'

// ---------- 1. match the bank's balance ----------

export interface BalanceCheck {
  accountId: number
  name: string
  type: string
  /** What the app shows now (negative = owed, for cards and loans). */
  appCents: number
  /** What the bank shows, in the same sign convention. */
  bankCents: number
  openingCents: number
  newOpeningCents: number
  txnCount: number
  firstDate: string | null
  lastDate: string | null
  /** Sentences the person should read before applying (a card that would start with a credit, a big change...). */
  warnings: string[]
  /** Charges the bank shows as pending and not yet in its balance (spending, as a positive number), if the person said. */
  pendingCents: number | null
  /** The balance once those post (negative = owed): the bank's balance minus the pending charges. */
  afterPendingCents: number | null
}

const owesType = (t: string) => t === 'credit_card' || t === 'loan'

function account(db: Db, profileId: number, id: number) {
  const a = db.prepare('SELECT id, name, type, profile_id AS p, opening_balance_cents AS opening FROM account WHERE id = ?').get(id) as { id: number; name: string; type: string; p: number; opening: number } | undefined
  if (!a || a.p !== profileId) throw new Error('That account no longer exists. Reload the page.')
  if (a.type === 'investment') throw new Error('Investment accounts are valued by hand; there is no history to match.')
  return a
}

/**
 * `bankInput` is what the person reads off the bank: for a chequing or savings account the balance, for a credit card or loan the
 * amount owed (a positive number). Nothing is changed.
 */
export function checkBalance(db: Db, profileId: number, accountId: number, bankInputCents: number, pendingCents: number | null = null): BalanceCheck {
  const a = account(db, profileId, accountId)
  if (!Number.isInteger(bankInputCents)) throw new Error('Enter the balance as an amount in dollars and cents.')
  const owes = owesType(a.type)
  if (owes && bankInputCents < 0) throw new Error('Enter what you owe as a positive number.')
  const bank = owes ? -bankInputCents : bankInputCents
  const s = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_cents), 0) sum, MIN(posted_date) first, MAX(posted_date) last FROM txn WHERE account_id = ?').get(accountId) as { n: number; sum: number; first: string | null; last: string | null }
  const app = accountValueCents(db, accountId) ?? 0
  const newOpening = bank - s.sum
  const warnings: string[] = []
  if (pendingCents !== null && (!Number.isInteger(pendingCents) || pendingCents < 0)) throw new Error('Enter the pending charges as a positive amount, or leave it empty.')
  if (pendingCents) warnings.push(`Your bank does not count the ${(pendingCents / 100).toFixed(2)} pending in that balance, and the app only holds posted transactions, so the two are matched on the posted balance. ${owes ? 'You will owe' : 'The balance will be'} ${(Math.abs(bank - pendingCents) / 100).toFixed(2)} once the pending ${pendingCents === 1 ? 'charge posts' : 'charges post'}; import them when they do.`)
  if (s.n === 0) warnings.push('This account has no transactions yet, so its starting balance is simply what the bank shows.')
  if (owes && newOpening > 0) warnings.push(`This would make the card START with a credit of ${(newOpening / 100).toFixed(2)} before its first transaction, which is not possible. It usually means payments or other transactions are missing from the imported history (or are recorded in another account). Check the transactions first.`)
  if (!owes && a.type !== 'other' && s.first && Math.abs(newOpening) > 500_000) warnings.push(`The starting balance would be ${(newOpening / 100).toFixed(2)}, a lot for before ${s.first}. Some transactions may be missing or duplicated.`)
  return { accountId, name: a.name, type: a.type, appCents: app, bankCents: bank, openingCents: a.opening, newOpeningCents: newOpening, txnCount: s.n, firstDate: s.first, lastDate: s.last, warnings, pendingCents, afterPendingCents: pendingCents === null ? null : bank - pendingCents }
}

/** Sets the starting balance so the account's balance equals the bank's. */
export function matchBankBalance(db: Db, profileId: number, accountId: number, bankInputCents: number, pendingCents: number | null = null): BalanceCheck {
  const c = checkBalance(db, profileId, accountId, bankInputCents, pendingCents)
  db.prepare('UPDATE account SET opening_balance_cents = ? WHERE id = ?').run(c.newOpeningCents, accountId)
  return { ...c, appCents: c.bankCents, openingCents: c.newOpeningCents }
}

// ---------- 2. the same transactions in two accounts ----------

export interface DuplicatePair {
  a: { id: number; name: string }
  b: { id: number; name: string }
  months: string[]
  /** Pairs of identical rows (same date and amount) in those months. */
  matches: number
  rowsA: number
  rowsB: number
  examples: { date: string; descriptionA: string; descriptionB: string; amountCents: number }[]
}

interface R { id: number; account: number; date: string; cents: number; description: string }

/** A month counts when at least this share of the smaller account's rows have an identical twin in the other account. */
const MONTH_SHARE = 0.8
const MIN_ROWS = 3
const MIN_MONTHS = 2
const MIN_MATCHES = 8

function pairRows(rowsA: R[], rowsB: R[]): [R, R][] {
  const key = (r: R) => `${r.date}|${r.cents}`
  const byB = new Map<string, R[]>()
  for (const r of rowsB) { const k = key(r); (byB.get(k) ?? byB.set(k, []).get(k)!).push(r) }
  const out: [R, R][] = []
  for (const r of rowsA) { const hit = byB.get(key(r))?.shift(); if (hit) out.push([r, hit]) }
  return out
}

function analyse(db: Db, profileId: number, aId: number, bId: number): { months: string[]; pairs: [R, R][]; rowsA: number; rowsB: number } {
  const rows = (id: number) => db.prepare('SELECT id, account_id AS account, posted_date AS date, amount_cents AS cents, COALESCE(description_raw, description) AS description FROM txn WHERE account_id = ? AND profile_id = ? ORDER BY posted_date, id').all(id, profileId) as R[]
  const A = rows(aId), B = rows(bId)
  const pairs = pairRows(A, B)
  const count = (rs: R[]) => { const m = new Map<string, number>(); for (const r of rs) m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) ?? 0) + 1); return m }
  const cA = count(A), cB = count(B), cP = count(pairs.map(([a]) => a))
  const months = [...cP.keys()].filter((m) => {
    const smaller = Math.min(cA.get(m) ?? 0, cB.get(m) ?? 0)
    return smaller >= MIN_ROWS && (cP.get(m) ?? 0) / smaller >= MONTH_SHARE
  }).sort()
  const inMonths = (r: R) => months.includes(r.date.slice(0, 7))
  const flagged = pairs.filter(([a]) => inMonths(a))
  return { months, pairs: flagged, rowsA: A.filter(inMonths).length, rowsB: B.filter(inMonths).length }
}

/** Pairs of the person's accounts that hold the same transactions in several months. Nothing is changed. */
export function findCrossDuplicates(db: Db, profileId: number): DuplicatePair[] {
  const accts = db.prepare("SELECT id, name FROM account WHERE profile_id = ? AND type NOT IN ('investment', 'cash') ORDER BY id").all(profileId) as { id: number; name: string }[]
  const out: DuplicatePair[] = []
  for (let i = 0; i < accts.length; i++) {
    for (let j = i + 1; j < accts.length; j++) {
      const r = analyse(db, profileId, accts[i]!.id, accts[j]!.id)
      if (r.months.length < MIN_MONTHS || r.pairs.length < MIN_MATCHES) continue
      out.push({
        a: accts[i]!, b: accts[j]!, months: r.months, matches: r.pairs.length, rowsA: r.rowsA, rowsB: r.rowsB,
        examples: r.pairs.slice(0, 6).map(([a, b]) => ({ date: a.date, descriptionA: a.description, descriptionB: b.description, amountCents: a.cents }))
      })
    }
  }
  return out.sort((x, y) => y.matches - x.matches)
}

/**
 * Deletes, from `fromAccountId`, the copies that also exist in `otherAccountId` (same date and amount, in the months where the two
 * accounts overlap almost completely). The other account is left exactly as it is. The caller makes a backup first.
 */
export function deleteCrossDuplicates(db: Db, profileId: number, fromAccountId: number, otherAccountId: number): { deleted: number } {
  if (fromAccountId === otherAccountId) throw new Error('Pick two different accounts.')
  for (const id of [fromAccountId, otherAccountId]) if (!db.prepare('SELECT 1 FROM account WHERE id = ? AND profile_id = ?').get(id, profileId)) throw new Error('That account no longer exists. Reload the page.')
  const r = analyse(db, profileId, fromAccountId, otherAccountId)
  if (r.pairs.length === 0) throw new Error('These two accounts no longer share duplicate transactions. Reload the page.')
  return db.transaction(() => {
    const ids = r.pairs.map(([a]) => a.id)
    const batches = new Set<number>()
    for (const chunk of chunks(ids, 500)) for (const r2 of db.prepare(`SELECT DISTINCT import_batch_id b FROM txn WHERE id IN (${chunk.map(() => '?').join(',')}) AND import_batch_id IS NOT NULL`).all(...chunk) as { b: number }[]) batches.add(r2.b)
    const groups = db.prepare(`SELECT DISTINCT transfer_group g FROM txn WHERE id IN (${ids.map(() => '?').join(',')}) AND transfer_group IS NOT NULL`).all(...ids) as { g: string }[]
    for (const chunk of chunks(ids, 500)) db.prepare(`DELETE FROM txn WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk)
    for (const { g } of groups) db.prepare('UPDATE txn SET transfer_group = NULL WHERE transfer_group = ? AND (SELECT COUNT(*) FROM txn WHERE transfer_group = ?) < 2').run(g, g)
    // an import that was nothing but copies disappears from the past-imports list
    for (const b of batches) db.prepare("DELETE FROM import_batch WHERE id = ? AND source = 'import' AND NOT EXISTS (SELECT 1 FROM txn WHERE import_batch_id = ?)").run(b, b)
    return { deleted: ids.length }
  })()
}

function chunks<T>(xs: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out }
