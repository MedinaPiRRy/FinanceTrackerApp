// Statement import: parse -> normalise -> classify -> categorise -> detect duplicates -> preview -> commit.
import crypto from 'node:crypto'
import type { Db } from './open'
import { pairTransfers } from './transfers'
import { rememberCategory } from './rules'
import { rememberLastAccount } from './importMatch'
import { findSourceRule, directionOf } from './sourceRules'
import { loadAmountMatcher } from './amountRules'
import { linkPaymentToDebt } from './debtPayments'
import { isPartnerPayee, partnerOf, addPartnerAlias } from './partners'
import { normalizeKey, displayName } from '../core/normalize'
import { daysBetween } from '../core/dates'
import { keyMatches } from '../core/categorize'
import { classifyRow, builtinTag, type Kind } from '../core/classify'
import { buildHistoryRules, categoryForTag, matchRule, type Rule } from '../core/categorize'
import type { ParsedStatement } from '../core/statement'

export interface PreviewRow {
  idx: number
  line: number
  date: string
  raw: string
  description: string
  key: string
  amountCents: number
  kind: Kind
  categoryId: number | null
  suggestedCategoryId: number | null
  suggestionSource: 'user' | 'alias' | 'history' | 'builtin' | null
  reviewReason: string | null
  /** Set when this is money between you and the other person (movement, not income or spending). */
  counterpartyProfileId: number | null
  /** A loan this payment counts toward (from a source the person told the app to always file that way). */
  debtId: number | null
  /**
   * new: not in the app. duplicate: the app already has it (same account, date, amount). repeat: identical to an
   * earlier line in this same file (same date, amount and bank description): left out until the user says it is real.
   */
  status: 'new' | 'duplicate' | 'repeat'
  matchedTxnId: number | null
  matchedDescription: string | null
  /** A row the app has with the same amount a day or two away and a similar name (bank posting date vs purchase date). */
  nearMatch: { date: string; description: string } | null
  include: boolean
}

export interface Preview {
  fileName: string
  format: string
  rows: PreviewRow[]
  warnings: string[]
  summary: { total: number; newCount: number; duplicateCount: number; repeatCount: number; nearMatchCount: number; needsReviewCount: number; minDate: string | null; maxDate: string | null; inCents: number; outCents: number }
}

interface Cat { id: number; name: string; kind: string; parentId: number | null }

function loadRules(db: Db, profileId: number): Rule[] {
  const stored = db.prepare(`SELECT pattern, merchant, category_id AS categoryId, priority, source FROM category_rule WHERE (profile_id = ? OR profile_id IS NULL) AND source IN ('user','learned')`).all(profileId) as { pattern: string; merchant: string | null; categoryId: number | null; priority: number; source: string }[]
  const rules: Rule[] = stored.map((r) => ({ pattern: r.pattern, merchant: r.merchant, categoryId: r.categoryId, priority: r.source === 'user' ? 10 : 20, source: r.source === 'user' ? 'user' : 'alias' }))
  // The person's own history (clean names and, where known, raw bank names)
  const hist = db.prepare(`SELECT description, description_raw AS raw, category_id AS categoryId FROM txn WHERE profile_id = ? AND category_id IS NOT NULL AND kind IN ('expense','refund','income')`).all(profileId) as { description: string; raw: string | null; categoryId: number }[]
  const rows = hist.flatMap((h) => [{ key: normalizeKey(h.description), description: h.description, categoryId: h.categoryId }, ...(h.raw ? [{ key: normalizeKey(h.raw), description: h.description, categoryId: h.categoryId }] : [])])
  return [...rules, ...buildHistoryRules(rows)]
}

const sha = (...p: (string | number)[]) => crypto.createHash('sha1').update(p.join('|')).digest('hex').slice(0, 24)

export function buildPreview(db: Db, profileId: number, accountId: number, parsed: ParsedStatement, fileName: string): Preview {
  const acc = db.prepare('SELECT id, type, profile_id AS p FROM account WHERE id = ?').get(accountId) as { id: number; type: string; p: number } | undefined
  if (!acc || acc.p !== profileId) throw new Error('Pick one of your own accounts to import into')
  if (acc.type === 'investment') throw new Error('Investment accounts are valued by hand and have no transactions to import')
  const cats = db.prepare('SELECT id, name, kind, parent_id AS parentId FROM category WHERE profile_id = ?').all(profileId) as Cat[]
  const mainCats = cats.filter((c) => c.parentId === null) // the built-in keywords file things under main categories; a subcategory is only ever chosen by the person or a rule
  const amountCategory = loadAmountMatcher(db, profileId)
  const catById = new Map(cats.map((c) => [c.id, c]))
  const rules = loadRules(db, profileId)
  const partner = partnerOf(db, profileId)

  // Existing rows in this account, for duplicate detection (same date + amount, counted so repeats are handled)
  const dates = parsed.rows.map((r) => r.date).sort()
  const existing = new Map<string, { id: number; description: string }[]>()
  const allExisting: { id: number; d: string; c: number; description: string }[] = []
  if (dates.length) {
    const rows = db.prepare("SELECT id, posted_date AS d, amount_cents AS c, description FROM txn WHERE account_id = ? AND posted_date BETWEEN date(?, '-3 day') AND date(?, '+3 day')").all(accountId, dates[0], dates[dates.length - 1]) as { id: number; d: string; c: number; description: string }[]
    allExisting.push(...rows)
    for (const r of rows) {
      const k = `${r.d}|${r.c}`
      const list = existing.get(k) ?? []
      list.push({ id: r.id, description: r.description })
      existing.set(k, list)
    }
  }

  const out: PreviewRow[] = parsed.rows.map((r, idx) => {
    const key = normalizeKey(r.description)
    const cls = classifyRow(acc.type, r.description, r.amountCents)
    const rule = matchRule(key, rules)
    let categoryId: number | null = null
    let source: PreviewRow['suggestionSource'] = null
    let reviewReason = cls.reviewReason
    if (cls.needsCategory) {
      const want = cls.kind === 'income' ? 'income' : 'expense'
      const ruleCat = rule?.categoryId != null ? catById.get(rule.categoryId) : undefined
      if (ruleCat && ruleCat.kind === want) { categoryId = ruleCat.id; source = rule!.source }
      else {
        const tag = cls.tag ?? builtinTag(key)
        const t = tag && want === 'expense' ? categoryForTag(tag, mainCats) : null
        if (t) { categoryId = t; source = 'builtin' }
      }
      // a rule that depends on the amount ("gas stations: up to $30 is snacks, more is gas") decides before anything else guesses
      const byAmount = cls.kind === 'expense' ? amountCategory(key, r.amountCents) : null
      if (byAmount !== null && catById.get(byAmount)?.kind === 'expense') { categoryId = byAmount; source = 'user' }
      if (categoryId === null) reviewReason = 'Needs a category'
    }
    let kind = cls.kind
    let counterpartyProfileId: number | null = null
    let debtId: number | null = null
    if (kind === 'unclassified' && /E-?TRANSFER/i.test(r.description) && partner && isPartnerPayee(db, profileId, r.description)) {
      kind = 'transfer'
      reviewReason = null
      counterpartyProfileId = partner.id
    }
    // a source the person already decided about ("always file money from Sam as income / Gifts") is filed the same way, in the same direction
    if ((kind === 'unclassified' || kind === 'expense' || kind === 'income' || kind === 'refund') && counterpartyProfileId === null) {
      const sr = findSourceRule(db, profileId, key, directionOf(r.amountCents))
      const srCat = sr?.categoryId != null ? catById.get(sr.categoryId) : undefined
      if (sr && kind === 'unclassified' && sr.kind === 'transfer') { kind = 'transfer'; reviewReason = null; categoryId = null; source = 'user' }
      else if (sr && srCat && srCat.kind === (sr.kind === 'income' ? 'income' : 'expense') && (kind === 'unclassified' || kind === sr.kind)) { kind = sr.kind; reviewReason = null; categoryId = srCat.id; source = 'user'; if (sr.kind === 'expense') debtId = sr.debtId }
    }
    let description: string
    if (counterpartyProfileId !== null) description = `E-Transfer ${r.amountCents > 0 ? 'from' : 'to'} ${displayName(key)} (between us)`
    else if (cls.kind === 'transfer') description = r.amountCents > 0 ? (acc.type === 'credit_card' ? 'Payment received (from chequing)' : 'Transfer in') : /TO CARD/i.test(r.description) ? 'Payment → credit card' : 'Transfer to another account'
    else if (/E-?TRANSFER/i.test(r.description)) description = `E-Transfer ${r.amountCents > 0 ? 'from' : 'to'} ${displayName(key)}`
    else description = rule?.merchant ?? displayName(key) ?? r.description
    return { idx, line: r.line, date: r.date, raw: r.description, description: description || r.description, key, amountCents: r.amountCents, kind, counterpartyProfileId, debtId, categoryId, suggestedCategoryId: categoryId, suggestionSource: source, reviewReason, status: 'new', matchedTxnId: null, matchedDescription: null, nearMatch: null, include: true }
  })

  // 1) already in the app: consume existing rows with the same date + amount, one per staged row
  const left = new Map([...existing].map(([k, v]) => [k, [...v]]))
  const consumed = new Set<number>()
  for (const r of out) {
    const hit = left.get(`${r.date}|${r.amountCents}`)?.shift()
    if (hit) { r.status = 'duplicate'; r.matchedTxnId = hit.id; r.matchedDescription = hit.description; r.include = false; consumed.add(hit.id) }
  }
  // 2) the same line twice in this file: the second copy is held back until the user confirms it is a real second purchase
  const seenLines = new Map<string, number>()
  for (const r of out) {
    const k = `${r.date}|${r.amountCents}|${r.raw}`
    const n = (seenLines.get(k) ?? 0) + 1
    seenLines.set(k, n)
    if (n > 1 && r.status === 'new') { r.status = 'repeat'; r.include = false }
  }
  // 3) similar row a day or two away (the bank's posting date vs the date the purchase was recorded): shown as a hint only
  for (const r of out) {
    if (r.status !== 'new') continue
    const hit = allExisting.find((e) => {
      if (consumed.has(e.id) || e.c !== r.amountCents) return false
      const gap = Math.abs(daysBetween(e.d, r.date))
      if (gap < 1 || gap > 3) return false
      const ek = normalizeKey(e.description)
      return keyMatches(ek, r.key) || keyMatches(r.key, ek) || ek === normalizeKey(r.description)
    })
    if (hit) r.nearMatch = { date: hit.d, description: hit.description }
  }

  const fresh = out.filter((r) => r.status === 'new')
  return {
    fileName,
    format: parsed.format,
    rows: out,
    warnings: parsed.warnings,
    summary: {
      total: out.length, newCount: fresh.length, duplicateCount: out.filter((r) => r.status === 'duplicate').length, repeatCount: out.filter((r) => r.status === 'repeat').length, nearMatchCount: fresh.filter((r) => r.nearMatch).length, needsReviewCount: fresh.filter((r) => r.reviewReason).length,
      minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null,
      inCents: out.filter((r) => r.amountCents > 0).reduce((s, r) => s + r.amountCents, 0), outCents: out.filter((r) => r.amountCents < 0).reduce((s, r) => s - r.amountCents, 0)
    }
  }
}

export interface CommitRow {
  date: string
  raw: string
  description: string
  key: string
  amountCents: number
  kind: Kind
  categoryId: number | null
  suggestedCategoryId: number | null
  reviewReason: string | null
  counterpartyProfileId: number | null
  debtId?: number | null
  status: 'new' | 'duplicate' | 'repeat'
  matchedTxnId: number | null
  include: boolean
}

export interface CommitResult { batchId: number; inserted: number; skippedExisting: number; learned: number; queuedForReview: number; transfersPaired: number }

const KINDS = new Set(['income', 'expense', 'refund', 'transfer', 'unclassified'])

/** Saves the previewed rows. Every row is re-validated here; the UI is never trusted. All-or-nothing. */
export function commitImport(db: Db, profileId: number, accountId: number, fileName: string, rows: CommitRow[], opts: { learnFromDuplicates: boolean; fileHash?: string | null; layout?: string | null; allowOtherAccount?: boolean }): CommitResult {
  const acc = db.prepare('SELECT id, type, profile_id AS p FROM account WHERE id = ?').get(accountId) as { id: number; type: string; p: number } | undefined
  if (!acc || acc.p !== profileId) throw new Error('Pick one of your own accounts to import into')
  const cats = new Map((db.prepare('SELECT id, kind, profile_id AS p FROM category WHERE profile_id = ?').all(profileId) as { id: number; kind: string; p: number }[]).map((c) => [c.id, c]))

  if (opts.fileHash && !opts.allowOtherAccount) {
    const before = db.prepare('SELECT a.name AS name FROM import_batch b JOIN account a ON a.id = b.account_id WHERE b.profile_id = ? AND b.file_hash = ? AND b.account_id != ? LIMIT 1').get(profileId, opts.fileHash, accountId) as { name: string } | undefined
    if (before) throw new Error(`This exact file was already imported into "${before.name}". Importing it into a different account would record every transaction twice. Confirm that this is what you want, or pick "${before.name}".`)
  }
  const result: CommitResult = { batchId: 0, inserted: 0, skippedExisting: 0, learned: 0, queuedForReview: 0, transfersPaired: 0 }
  db.transaction(() => {
    result.batchId = Number(db.prepare('INSERT INTO import_batch (profile_id, source, filename, row_count, account_id, file_hash, layout) VALUES (?,?,?,0,?,?,?)').run(profileId, 'import', fileName, accountId, opts.fileHash ?? null, opts.layout ?? null).lastInsertRowid)
    const insert = db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, category_id, kind, review_reason, counterparty_profile_id, source, import_batch_id, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,'import',?,?)`)
    const upsertRule = db.prepare(`INSERT INTO category_rule (profile_id, pattern, match_type, merchant, category_id, priority, source) VALUES (?,?,?,?,?,?,?)`)
    const delRule = db.prepare(`DELETE FROM category_rule WHERE profile_id = ? AND pattern = ? AND source = ?`)
    const seen = new Map<string, number>()

    for (const r of rows) {
      if (!KINDS.has(r.kind)) throw new Error(`Row ${r.date} ${r.raw}: unknown type "${r.kind}"`)
      if (!r.include) {
        // Learn names/categories from rows the app already has (e.g. a statement imported earlier or entered by hand).
        if (opts.learnFromDuplicates && r.status === 'duplicate' && r.matchedTxnId) {
          const t = db.prepare('SELECT id, description, description_raw AS raw, category_id AS c, kind FROM txn WHERE id = ? AND profile_id = ? AND account_id = ?').get(r.matchedTxnId, profileId, accountId) as { id: number; description: string; raw: string | null; c: number | null; kind: string } | undefined
          if (t) {
            if (!t.raw) db.prepare('UPDATE txn SET description_raw = ? WHERE id = ?').run(r.raw, t.id)
            const hasUser = db.prepare(`SELECT 1 FROM category_rule WHERE profile_id = ? AND pattern = ? AND source = 'user'`).get(profileId, r.key)
            if (t.c !== null && r.key && !hasUser && ['expense', 'refund', 'income'].includes(t.kind)) {
              delRule.run(profileId, r.key, 'learned')
              upsertRule.run(profileId, r.key, 'exact', t.description, t.c, 20, 'learned')
              result.learned++
            }
          }
        }
        continue
      }
      const desc = (r.description ?? '').trim() || r.raw
      // sign rules: the meaning of money can never be flipped silently
      if (r.kind === 'income' && r.amountCents <= 0) throw new Error(`"${desc}" on ${r.date}: income must be money coming in`)
      if (r.kind === 'expense' && r.amountCents >= 0) throw new Error(`"${desc}" on ${r.date}: an expense must be money going out`)
      if (r.kind === 'refund' && r.amountCents <= 0) throw new Error(`"${desc}" on ${r.date}: a refund must be money coming in`)
      let categoryId = r.categoryId
      if (r.kind === 'transfer' || r.kind === 'unclassified') categoryId = null
      if (categoryId !== null) {
        const c = cats.get(categoryId)
        const want = r.kind === 'income' ? 'income' : 'expense'
        if (!c) throw new Error(`"${desc}": that category belongs to another person or no longer exists`)
        if (c.kind !== want) throw new Error(`"${desc}": a ${r.kind} needs a ${want} category`)
      }
      let reason = r.reviewReason
      if (r.kind === 'unclassified' && !reason) reason = 'Needs your decision'
      if ((r.kind === 'income' || r.kind === 'expense' || r.kind === 'refund') && categoryId === null && !reason) reason = 'Needs a category'
      if (categoryId !== null && reason === 'Needs a category') reason = null // user picked one in the preview

      const base = sha(profileId, accountId, r.date, r.amountCents, r.key)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      const fingerprint = `imp-${base}#${n}`
      if (db.prepare('SELECT 1 FROM txn WHERE profile_id = ? AND fingerprint = ?').get(profileId, fingerprint)) { result.skippedExisting++; continue } // true repeat of an earlier import
      let counterparty: number | null = null
      if (r.counterpartyProfileId != null) {
        if (r.kind !== 'transfer') throw new Error(`"${desc}": only a transfer can be between you and the other person`)
        const other = db.prepare("SELECT id FROM profile WHERE id = ? AND kind = 'person'").get(r.counterpartyProfileId) as { id: number } | undefined
        if (!other || other.id === profileId) throw new Error(`"${desc}": pick the other person`)
        counterparty = other.id
        addPartnerAlias(db, profileId, r.raw || desc)
      }
      const ins = insert.run(profileId, accountId, r.date, r.amountCents, desc, r.raw, categoryId, r.kind, reason, counterparty, result.batchId, fingerprint)
      // counts toward a loan the person tracks; a stale link (the loan was deleted since) must not stop the import
      if (r.debtId && r.kind === 'expense') { try { linkPaymentToDebt(db, Number(ins.lastInsertRowid), r.debtId) } catch { /* the payment is still imported */ } }
      result.inserted++
      if (reason) result.queuedForReview++

      // remember corrections: a category the user chose (or changed) becomes a rule for next time
      if (categoryId !== null && r.key && categoryId !== r.suggestedCategoryId && (r.kind === 'expense' || r.kind === 'refund' || r.kind === 'income')) {
        if (rememberCategory(db, profileId, r.raw || r.key, desc, categoryId)) result.learned++
      }
    }
    db.prepare('UPDATE import_batch SET row_count = ? WHERE id = ?').run(result.inserted, result.batchId)
    result.transfersPaired = pairTransfers(db, profileId)
    rememberLastAccount(db, profileId, accountId)
  })()
  return result
}

export interface BatchInfo { id: number; fileName: string | null; importedAt: string; rowCount: number; remaining: number; undoable: boolean }

export function listImports(db: Db, profileId: number): BatchInfo[] {
  const rows = db.prepare(`SELECT b.id, b.filename AS fileName, b.imported_at AS importedAt, b.row_count AS rowCount, b.source, (SELECT COUNT(*) FROM txn t WHERE t.import_batch_id = b.id) AS remaining FROM import_batch b WHERE b.profile_id = ? ORDER BY b.id DESC`).all(profileId) as { id: number; fileName: string | null; importedAt: string; rowCount: number; source: string; remaining: number }[]
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, importedAt: r.importedAt, rowCount: r.rowCount, remaining: r.remaining, undoable: r.source === 'import' && r.remaining > 0 }))
}

/** Removes everything a statement import added. Only batches created by the statement importer. */
export function undoImport(db: Db, profileId: number, batchId: number): number {
  const b = db.prepare('SELECT source FROM import_batch WHERE id = ? AND profile_id = ?').get(batchId, profileId) as { source: string } | undefined
  if (!b) throw new Error('That import no longer exists. Reload the page.')
  if (b.source !== 'import') throw new Error('Only statement imports can be undone.')
  return db.transaction(() => {
    const groups = db.prepare('SELECT DISTINCT transfer_group g FROM txn WHERE import_batch_id = ? AND transfer_group IS NOT NULL').all(batchId) as { g: string }[]
    const n = db.prepare('DELETE FROM txn WHERE import_batch_id = ? AND profile_id = ?').run(batchId, profileId).changes
    // a transfer whose other half was just removed becomes unlinked again
    for (const { g } of groups) db.prepare('UPDATE txn SET transfer_group = NULL WHERE transfer_group = ? AND (SELECT COUNT(*) FROM txn WHERE transfer_group = ?) < 2').run(g, g)
    db.prepare('DELETE FROM import_batch WHERE id = ?').run(batchId)
    return n
  })()
}
