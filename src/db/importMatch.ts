// Helps the import page pick the right account: the one used last, the one a file matches by name or column layout,
// and the account a byte-identical file was imported into before. These are only suggestions the person can change.
import crypto from 'node:crypto'
import type { Db } from './open'
import { layoutOf } from '../core/statement'

export interface ImportMeta {
  /** SHA-256 of the file's bytes: the same file has the same hash no matter what it is renamed to. */
  fileHash: string
  /** The column layout of the file (see layoutOf), remembered per account once an import is saved. */
  layout: string
  /** Set when exactly this file was already imported (and not undone). */
  sameFileBefore: { batchId: number; importedAt: string; accountId: number | null; accountName: string | null; rowCount: number } | null
}

export type SuggestionReason = 'same_file' | 'layout' | 'file_name' | 'card_layout' | 'last_used'
export interface AccountSuggestion { accountId: number; reason: SuggestionReason; message: string }

export const hashFile = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

const lastKey = (profileId: number) => `import_last_account_${profileId}`

export function rememberLastAccount(db: Db, profileId: number, accountId: number): void {
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(lastKey(profileId), String(accountId))
}

interface Acc { id: number; name: string; type: string; institution: string | null }
const usableAccounts = (db: Db, profileId: number) =>
  db.prepare("SELECT id, name, type, institution FROM account WHERE profile_id = ? AND archived = 0 AND type NOT IN ('investment','cash','loan') ORDER BY id").all(profileId) as Acc[]

export function previousImportOf(db: Db, profileId: number, fileHash: string): ImportMeta['sameFileBefore'] {
  const r = db.prepare(`SELECT b.id AS batchId, b.imported_at AS importedAt, b.account_id AS accountId, a.name AS accountName, b.row_count AS rowCount
    FROM import_batch b LEFT JOIN account a ON a.id = b.account_id WHERE b.profile_id = ? AND b.file_hash = ? ORDER BY b.id DESC LIMIT 1`).get(profileId, fileHash) as NonNullable<ImportMeta['sameFileBefore']> | undefined
  return r ?? null
}

const GENERIC = new Set(['statement', 'statements', 'export', 'exports', 'transactions', 'transaction', 'download', 'downloaded', 'activity', 'account', 'accounts', 'history', 'csv', 'xlsx', 'xls', 'txt', 'report', 'the', 'and', 'for', 'copy', 'final', 'new', 'bank', 'banking', 'all'])
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC.has(t))

// Words people put in file names, mapped to the account type they suggest.
const TYPE_WORDS: Record<string, string> = { chequing: 'chequing', checking: 'chequing', chq: 'chequing', savings: 'savings', saving: 'savings', visa: 'credit_card', mastercard: 'credit_card', amex: 'credit_card', credit: 'credit_card', card: 'credit_card', cc: 'credit_card' }

function byFileName(accounts: Acc[], fileName: string): Acc | null {
  const ft = new Set(tokens(fileName.replace(/\.[^.]+$/, '')))
  if (ft.size === 0) return null
  const typeHits = new Set([...ft].map((t) => TYPE_WORDS[t]).filter((x): x is string => !!x))
  const scored = accounts.map((a) => {
    const nameTokens = new Set(tokens(`${a.name} ${a.institution ?? ''}`))
    let score = 0
    for (const t of nameTokens) if (ft.has(t)) score += 2
    // a type word only counts when it narrows things down to one account of that type
    if (typeHits.has(a.type) && accounts.filter((x) => x.type === a.type).length === 1) score += 1
    return { a, score }
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score)
  if (scored.length === 0) return null
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null // ambiguous: better to ask than to guess
  return scored[0]!.a
}

/**
 * Best guess for which account a file belongs to, strongest evidence first:
 * the same file imported before, the same column layout imported before, a name that matches an account,
 * a card-style layout when there is exactly one credit card, and finally the account used last time.
 */
export function suggestAccount(db: Db, profileId: number, file: { name: string; layout: string; hash: string } | null): AccountSuggestion | null {
  const accounts = usableAccounts(db, profileId)
  const byId = new Map(accounts.map((a) => [a.id, a]))
  if (file) {
    const before = previousImportOf(db, profileId, file.hash)
    if (before?.accountId && byId.has(before.accountId)) return { accountId: before.accountId, reason: 'same_file', message: `This exact file was imported into ${byId.get(before.accountId)!.name} before.` }

    const sameLayout = db.prepare('SELECT account_id AS accountId FROM import_batch WHERE profile_id = ? AND layout = ? AND account_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(profileId, file.layout) as { accountId: number } | undefined
    if (sameLayout && byId.has(sameLayout.accountId)) return { accountId: sameLayout.accountId, reason: 'layout', message: `The columns match your earlier import into ${byId.get(sameLayout.accountId)!.name}.` }

    const named = byFileName(accounts, file.name)
    if (named) return { accountId: named.id, reason: 'file_name', message: `The file name matches ${named.name}.` }

    if (file.layout === 'cols:5') {
      const cards = accounts.filter((a) => a.type === 'credit_card')
      if (cards.length === 1) return { accountId: cards[0]!.id, reason: 'card_layout', message: `This looks like a credit card export and ${cards[0]!.name} is your only card.` }
    }
  }
  const last = Number((db.prepare('SELECT value FROM setting WHERE key = ?').get(lastKey(profileId)) as { value: string } | undefined)?.value)
  if (last && byId.has(last)) return { accountId: last, reason: 'last_used', message: `Last account you imported into: ${byId.get(last)!.name}.` }
  return null
}

export { layoutOf }
