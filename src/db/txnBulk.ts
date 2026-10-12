// Edit or delete many transactions at once (from the Transactions page, after ticking rows).
// Moving rows to another category is `setCategoryMany` in queries.ts; this is the rest of what a person needs when a payment was filed wrong:
// rename the merchant, change what kind of money it is (spending, income, refund, transfer), or remove it.
import type { Db } from './open'
import { BULK_LIMIT } from './queries'
import { rememberCategory } from './rules'
import { unlinkPayment } from './debtPayments'

export type BulkKind = 'expense' | 'income' | 'refund' | 'transfer'
export interface BulkEdit {
  /** New merchant name for every selected row (blank or missing = leave as is). */
  description?: string
  /** New kind of money (missing = leave as is). Transfers lose their category; the others need one that fits. */
  kind?: BulkKind
  /** Category to file them under. Required when a change of kind leaves a row without a fitting category. */
  categoryId?: number
  /** Remember the (new) merchant name for this category on future imports. */
  remember?: boolean
}

interface Row { id: number; profile_id: number; amount_cents: number; kind: string; category_id: number | null; description: string; raw: string | null; group: string | null; source: string; catKind: string | null }

const MAX_NAME = 120

function load(db: Db, ids: number[]): Row[] {
  const rows = db.prepare(`SELECT t.id, t.profile_id, t.amount_cents, t.kind, t.category_id, t.description, t.description_raw AS raw, t.transfer_group AS "group", t.source, c.kind AS catKind
    FROM txn t LEFT JOIN category c ON c.id = t.category_id WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]
  if (rows.length !== ids.length) throw new Error('Some of those transactions no longer exist. Reload the page.')
  return rows
}

function checkIds(txnIds: number[]): number[] {
  const ids = [...new Set(txnIds)]
  if (ids.length === 0) throw new Error('Select at least one transaction first.')
  if (ids.length > BULK_LIMIT) throw new Error(`Select at most ${BULK_LIMIT} transactions at a time.`)
  return ids
}

/**
 * Rows the app has already written to the person's Excel workbook (the personal app only; other databases have no such column). Deleting or
 * re-typing one here would leave the workbook saying something else and the sheet totals no longer matching the app.
 */
function refuseSynced(db: Db, ids: number[], what: string) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('txn') WHERE name = 'excel_flow_at'").get()) return
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM txn WHERE id IN (${ids.map(() => '?').join(',')}) AND (excel_flow_at IS NOT NULL OR excel_ledger_at IS NOT NULL)`).get(...ids) as { n: number }).n
  if (n > 0) throw new Error(`${n.toLocaleString()} of the selected transaction${n === 1 ? ' was' : 's were'} already written to your Excel workbook, so ${what} here would leave the workbook and the app disagreeing. Change ${n === 1 ? 'it' : 'them'} in the workbook too, or leave ${n === 1 ? 'it' : 'them'} as ${n === 1 ? 'it is' : 'they are'}.`)
}

/** Rows that come from a workbook are managed by the Excel sync, not here. */
function refuseWorkbook(rows: Row[], verb: string) {
  const n = rows.filter((r) => r.source === 'workbook').length
  if (n > 0) throw new Error(`${n.toLocaleString()} of the selected transaction${n === 1 ? ' comes' : 's come'} from your workbook, and ${verb} them here would be undone by the next sync. Change them in the workbook instead.`)
}

export function editTxnMany(db: Db, txnIds: number[], edit: BulkEdit): { updated: number; remembered: number } {
  const ids = checkIds(txnIds)
  const name = edit.description?.trim() ?? ''
  if (name.length > MAX_NAME) throw new Error(`That name is too long (${MAX_NAME} characters at most).`)
  if (!name && !edit.kind && edit.categoryId === undefined) throw new Error('Choose what to change: a new name, a different type, or a category.')
  const rows = load(db, ids)
  refuseWorkbook(rows, 'changing')
  if (name || edit.kind) refuseSynced(db, ids, 'renaming or re-typing them') // a category on its own is allowed: the Excel page already reports categories changed after a sync

  const cat = edit.categoryId === undefined ? null : (db.prepare('SELECT profile_id AS p, kind FROM category WHERE id = ?').get(edit.categoryId) as { p: number; kind: 'income' | 'expense' } | undefined) ?? null
  if (edit.categoryId !== undefined && !cat) throw new Error('That category no longer exists. Pick another.')

  const structural = !!edit.kind || !!cat
  const plan = rows.map((r) => {
    if (!structural) return { r, kind: r.kind, categoryId: r.category_id, clearGroup: false }
    const kind = edit.kind ?? (r.kind as string)
    let categoryId: number | null = r.category_id
    let clearGroup = false
    if (kind === 'transfer') {
      if (edit.categoryId !== undefined) throw new Error('A transfer between accounts has no category.')
      categoryId = null
    } else if (kind === 'income' || kind === 'expense' || kind === 'refund') {
      if (kind === 'expense' && r.amount_cents >= 0) throw new Error('An expense has to be money going out. Some of the selected rows are money coming in.')
      if ((kind === 'income' || kind === 'refund') && r.amount_cents <= 0) throw new Error(`${kind === 'income' ? 'Income' : 'A refund'} has to be money coming in. Some of the selected rows are money going out.`)
      const need = kind === 'income' ? 'income' : 'expense'
      if (cat) {
        if (cat.p !== r.profile_id) throw new Error('That category belongs to someone else, and some selected transactions are not theirs.')
        if (cat.kind !== need) throw new Error(`A ${cat.kind} category does not fit ${kind === 'income' ? 'income' : kind === 'refund' ? 'refund' : 'spending'} rows.`)
        categoryId = edit.categoryId!
      } else if (edit.kind && (r.catKind !== need)) {
        throw new Error(`Choose a ${need} category for the rows that change to ${kind === 'income' ? 'income' : kind === 'refund' ? 'a refund' : 'spending'}.`)
      }
    } else throw new Error('Waiting rows are decided on the Review page.')
    if (edit.kind && edit.kind !== r.kind && r.group) {
      // the other side of a transfer would be left pointing at nothing
      if (db.prepare('SELECT 1 FROM txn WHERE transfer_group = ? AND id <> ?').get(r.group, r.id)) throw new Error('Some of these are one side of a transfer that has a matching row in another account. Leave those as they are, or change both sides.')
      clearGroup = true
    }
    return { r, kind, categoryId, clearGroup }
  })
  // a category chosen without a change of kind only fits rows that have one
  if (cat && !edit.kind) for (const p of plan) {
    if (p.r.kind !== 'income' && p.r.kind !== 'expense' && p.r.kind !== 'refund') throw new Error('Only income, expense and refund rows have a category. Change their type too, or select other rows.')
  }

  let remembered = 0
  db.transaction(() => {
    const rename = db.prepare('UPDATE txn SET description = ? WHERE id = ?')
    const upd = db.prepare("UPDATE txn SET description = ?, kind = ?, category_id = ?, transfer_group = CASE WHEN ? THEN NULL ELSE transfer_group END, counterparty_profile_id = CASE WHEN ? = 'transfer' THEN counterparty_profile_id ELSE NULL END, review_reason = NULL, reviewed_at = CASE WHEN review_reason IS NOT NULL THEN datetime('now') ELSE reviewed_at END WHERE id = ?")
    for (const { r, kind, categoryId, clearGroup } of plan) {
      const description = name || r.description
      if (structural) upd.run(description, kind, categoryId, clearGroup ? 1 : 0, kind, r.id); else rename.run(description, r.id)
      if (edit.remember && categoryId !== null && rememberCategory(db, r.profile_id, r.raw ?? r.description, description, categoryId)) remembered++
    }
  })()
  return { updated: plan.length, remembered }
}

/** Removes the selected transactions for good. A payment counted toward a loan is un-counted first so the loan's balance is put back. */
export function deleteTxnMany(db: Db, txnIds: number[]): { deleted: number } {
  const ids = checkIds(txnIds)
  const rows = load(db, ids)
  refuseWorkbook(rows, 'deleting')
  refuseSynced(db, ids, 'deleting them')
  db.transaction(() => {
    for (const r of rows) {
      if (db.prepare('SELECT 1 FROM debt_payment WHERE txn_id = ?').get(r.id)) unlinkPayment(db, r.id)
      db.prepare('DELETE FROM txn WHERE id = ?').run(r.id)
    }
  })()
  return { deleted: rows.length }
}
