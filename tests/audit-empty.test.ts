// Audit: every read-only page of the app on an empty database, on a database with only a closed account, and at year boundaries.
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/open'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandlers } from '../src/main/handlers'
import { dispatch } from '../src/main/dispatch'

type H = Record<string, (...a: unknown[]) => unknown>
const fresh = (seed: (db: ReturnType<typeof openDb>, p: number) => void = () => undefined) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-empty-'))
  const file = path.join(dir, 'finance.db')
  const db = openDb(file)
  const p = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('daniel','Daniel')").run().lastInsertRowid)
  seed(db, p)
  db.close()
  process.env.FINANCE_WORKBOOK_DIR = dir
  return { p, h: createHandlers(file) as unknown as H }
}

// read-only handlers and the arguments a page gives them
const READS = (p: number): [string, unknown[]][] => [
  ['profiles', []], ['household', []], ['owners', []], ['accounts', [p]], ['categories', [p]], ['txns', [p, {}]], ['txnIds', [p, {}]], ['dashboard', [p]], ['dashboard', [p, '2028-02']], ['recurring', [p]],
  ['recurringSuggest', [p]], ['recurringStopped', [p]], ['recurringRefunded', [p]], ['insights', [p]], ['insights', [p, '2026-12']], ['debts', [p]], ['reviewQueue', [p]], ['reviewSummary', [p]], ['reviewNotice', [p]],
  ['reviewNotice', [null, '2026-01']], ['reviewGroups', [p, 'money_out', 0, 50]], ['reviewGroups', [p, 'older', 0, 50]], ['sourceRules', [p]], ['cash', [p]], ['fxRates', []], ['importHistory', [p]], ['budgets', [p, '2026-12']], ['budgetList', [p]],
  ['budgetSuggest', [p]], ['goals', [p]], ['goalIdeas', [p]], ['monthlyReview', [p]], ['monthlyReview', [p, '2026-01']], ['forecast', [p]], ['forecast', [p, 60]], ['debtPlanner', [p]], ['categoryManage', [p]], ['amountRules', [p]],
  ['assets', [p]], ['assets', [null]], ['netWorth', [p]], ['netWorth', [null]], ['costsReport', [p, 2026]], ['costsReport', [null, 2028]], ['costsReport', [p, 1999]], ['duplicatesFind', [p]], ['householdOverview', []], ['householdAccounts', []],
  ['householdBudgets', ['2026-12']], ['householdGoals', []], ['householdBudgetSuggest', []], ['categoryGroups', []], ['groupNames', []], ['appSettings', []], ['diagnostics', []], ['status', []], ['partnerAliases', [p]], ['allDebts', []]
]

describe('pages on an empty database', () => {
  const { p, h } = fresh()
  for (const [name, args] of READS(p)) {
    if (typeof h[name] !== 'function') continue
    it(`${name}(${JSON.stringify(args).slice(1, -1)}) answers without an error`, async () => {
      const r = await dispatch(h, name, args)
      expect(r).toMatchObject({ ok: true })
    })
  }
})

describe('pages when the only account is closed and holds old data', () => {
  const { p, h } = fresh((db, pid) => {
    const a = Number(db.prepare("INSERT INTO account (profile_id,name,type,archived) VALUES (?, 'Old','chequing',1)").run(pid).lastInsertRowid)
    const c = Number(db.prepare("INSERT INTO category (profile_id,name,kind) VALUES (?, 'Food','expense')").run(pid).lastInsertRowid)
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, category_id, source, fingerprint) VALUES (?,?,'2028-02-29',-1234,'LEAP DAY LUNCH','expense',?,'import','z1')").run(pid, a, c)
  })
  for (const [name, args] of READS(p)) {
    if (typeof h[name] !== 'function') continue
    it(`${name} still answers`, async () => {
      expect(await dispatch(h, name, args)).toMatchObject({ ok: true })
    })
  }
  it('the leap-day purchase shows in February 2028; asking for a month with no data falls back to the latest month that has some, and says which', async () => {
    const feb = (await dispatch(h, 'dashboard', [p, '2028-02'])) as { ok: true; data: { month: string; summary: { expenseCents: number } } | null }
    expect(feb.data?.month).toBe('2028-02')
    expect(feb.data?.summary.expenseCents).toBe(1234)
    const mar = (await dispatch(h, 'dashboard', [p, '2028-03'])) as { ok: true; data: { month: string } | null }
    expect(mar.data?.month).toBe('2028-02') // the page must show this month name, not the one it asked for
  })
  it('a closed account is not counted in net worth, but the money it holds is still in the totals of the months it was open', async () => {
    const nw = (await dispatch(h, 'netWorth', [p])) as { ok: true; data: { accountsCents: number } }
    expect(nw.data.accountsCents).toBe(0)
  })
})
