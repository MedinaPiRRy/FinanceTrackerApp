// Every operation the UI can perform. Used by Electron (via IPC) and by the dev API server.
// The renderer never touches the database or the file system directly.
import path from 'node:path'
import fs from 'node:fs'
import { openDb, defaultDbPath, ensureHouseholdProfile, type Db } from '../db/open'
import { listProfiles, findHouseholdProfile, listAccounts, listCategories, queryTxns, setTxnCategory, createCategory, getDashboard, listRecurring, listCashBills, listDebts, type TxnFilter } from '../db/queries'
import { listReviewQueue, resolveReview, setValuation, type Decision } from '../db/review'
import { addTip, lastRates, addCashSpend, recordCashBill, depositCash, deleteCashEntry, cashBalanceCents } from '../db/cash'
import { buildPreview, commitImport, listImports, undoImport, type CommitRow } from '../db/import'
import { readStatementRows } from '../importers/statementFile'
import { parseStatement, validColumnMap, layoutOf, type ParseOptions } from '../core/statement'
import { hashFile, previousImportOf, suggestAccount, type ImportMeta } from '../db/importMatch'
import { createBudget, updateBudget, deleteBudget, budgetReport, suggestBudgets, createBudgets } from '../db/budgets'
import { createGoal, updateGoal, deleteGoal, listGoals, type GoalDto } from '../db/goals'
import { createDebt, updateDebtBalance, debtHistory } from '../db/debts'
import { getMonthlyReview } from '../db/monthly'
import { createAccount, setCreditLimit, renameAccount, closeAccount, reopenAccount, moveAccount, type NewAccount } from '../db/accounts'
import { createSetup, getAppMode, type AppMode, type NewPerson } from '../db/defaults'
import { generateSample } from '../demo/sample'
import { getForecast, saveWhatIf } from '../db/forecast'
import type { WhatIf } from '../core/forecast'
import { getPlanner, savePlanner, resetPlanner, type PlannerEdits } from '../db/debtPlan'
import { goalIdeas, createGoalsFromIdeas } from '../db/goalIdeas'
import { insightsFor, insightEvidence } from '../db/insights'
import { createRecurring, updateRecurring, deleteRecurring, type RecurringInput } from '../db/recurringManage'
import { suggestRecurring, addDetected, dismissSuggestion, stoppedItems, answerStopped } from '../db/recurringDetect'
import { getPartnerAliases, setPartnerAliases, partnerOf } from '../db/partners'
import { getHouseholdOverview, listHouseholdAccounts, listHouseholdBudgets, householdBudgetReport, createHouseholdBudget, updateHouseholdBudget, deleteHouseholdBudget, listHouseholdGoals, listCategoryGroups, setCategoryGroup, listGroupNames, listOwners, suggestHouseholdBudgets, createHouseholdBudgets } from '../db/household'

export function createHandlers(realPath: string = process.env.FINANCE_DB ?? defaultDbPath()) {
  // Sample data lives in its own database file, so it can never mix with real data. app-state.json says which one is open.
  const dataDir = path.dirname(realPath)
  const samplePath = path.join(dataDir, 'sample.db')
  const statePath = path.join(dataDir, 'app-state.json')
  const canSwitch = realPath !== ':memory:'
  const sampleActive = () => { try { return canSwitch && JSON.parse(fs.readFileSync(statePath, 'utf8')).active === 'sample' && fs.existsSync(samplePath) } catch { return false } }
  const setActive = (active: 'real' | 'sample') => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify({ active })) }
  let db: Db | null = null
  let openPath = ''
  const dbPath = () => (sampleActive() ? samplePath : realPath)
  const open = () => {
    const want = dbPath()
    if (db && openPath !== want) { db.close(); db = null }
    if (!db) { db = openDb(want); openPath = want }
    return db
  }
  const removeSampleFiles = () => { for (const ext of ['', '-wal', '-shm']) fs.rmSync(samplePath + ext, { force: true }) }
  const profileCount = () => (open().prepare("SELECT COUNT(*) n FROM profile WHERE kind = 'person'").get() as { n: number }).n
  const today = () => new Date().toLocaleDateString('en-CA')

  const backup = () => {
    const dir = path.join(dataDir, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `finance-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
    open().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
    return { file, sizeBytes: fs.statSync(file).size }
  }
  return {
    status: () => {
      const hasData = profileCount() > 0
      return { dbPath: dbPath(), hasData, mode: hasData ? getAppMode(open()) : null, sample: sampleActive() }
    },

    /** First run, "use my own data": creates the people (and the shared household if chosen) with starter categories and accounts. */
    setupOwn: (mode: AppMode, people: NewPerson[]) => {
      if (sampleActive()) throw new Error('Sample data is open. Switch back to your own data first.')
      const d = open()
      const ids = createSetup(d, mode, people)
      if (mode === 'couple_household') ensureHouseholdProfile(d)
      return ids
    },
    /** First run, "try sample data": fills a separate database with a made-up person or couple. Real data is never touched. */
    startSample: (mode: AppMode) => {
      if (!canSwitch) throw new Error('Sample data needs a database file.')
      db?.close(); db = null
      removeSampleFiles()
      openDb(samplePath).close() // creates the file; the state file only points at a sample that exists
      setActive('sample')
      return generateSample(open(), mode)
    },
    /** Leaves the sample and goes back to the user's own (possibly still empty) data. The sample file is deleted. */
    endSample: () => {
      db?.close(); db = null
      setActive('real')
      removeSampleFiles()
      return { ok: true }
    },

    profiles: () => listProfiles(open()),
    /** The shared household, or null in single and couple setups. */
    household: () => findHouseholdProfile(open()),
    owners: () => listOwners(open()),
    partner: (profileId: number) => partnerOf(open(), profileId),
    accounts: (profileId: number) => listAccounts(open(), profileId),
    categories: (profileId: number) => listCategories(open(), profileId),
    createCategory: (profileId: number, name: string, kind: 'expense' | 'income') => createCategory(open(), profileId, name, kind),
    txns: (profileId: number, filter: TxnFilter) => queryTxns(open(), profileId, filter),
    setCategory: (txnId: number, categoryId: number) => setTxnCategory(open(), txnId, categoryId),
    dashboard: (profileId: number, month?: string) => getDashboard(open(), profileId, month),
    recurring: (profileId: number) => listRecurring(open(), profileId),
    recurringCreate: (profileId: number, input: RecurringInput) => createRecurring(open(), profileId, input),
    recurringUpdate: (profileId: number, id: number, input: RecurringInput) => updateRecurring(open(), profileId, id, input),
    recurringDelete: (profileId: number, id: number) => deleteRecurring(open(), profileId, id),
    /** Regular payments found in the transactions that are not tracked yet. Nothing is saved. */
    recurringSuggest: (profileId: number) => suggestRecurring(open(), profileId, today()),
    recurringAdd: (profileId: number, items: { key: string; direction: 'income' | 'expense'; name?: string }[]) => addDetected(open(), profileId, items, today()),
    recurringDismiss: (profileId: number, key: string, direction: 'income' | 'expense') => dismissSuggestion(open(), profileId, key, direction),
    /** Tracked payments that stopped appearing: "was it cancelled?" */
    recurringStopped: (profileId: number) => stoppedItems(open(), profileId),
    recurringAnswer: (profileId: number, id: number, answer: 'cancelled' | 'active') => answerStopped(open(), profileId, id, answer, today()),
    /** Everything the Insights tab and the opening banner show. */
    insights: (profileId: number, month?: string) => insightsFor(open(), profileId, month, today()),
    insightEvidence: (profileId: number, ref: import('../core/insights').InsightRef) => insightEvidence(open(), profileId, ref, today()),
    debts: (profileId: number) => listDebts(open(), profileId),
    /** Every person's loans, labelled with whose they are (for household goals). */
    allDebts: () => (open().prepare("SELECT d.id, d.name || ' (' || p.name || ')' AS name, d.balance_cents AS balanceCents, d.as_of AS asOf, d.notes FROM debt d JOIN profile p ON p.id = d.profile_id ORDER BY d.balance_cents DESC").all() as { id: number; name: string; balanceCents: number; asOf: string; notes: string | null }[]),

    reviewQueue: (profileId: number) => listReviewQueue(open(), profileId),
    resolveReview: (txnId: number, decision: Decision) => resolveReview(open(), txnId, decision),
    setValuation: (accountId: number, asOf: string, valueCents: number, note?: string) => setValuation(open(), accountId, asOf, valueCents, note),

    cash: (profileId: number) => {
      const d = open()
      const cash = listAccounts(d, profileId).find((a) => a.type === 'cash')
      const entries = cash ? queryTxns(d, profileId, { accountId: cash.id, limit: 100 }).rows : []
      return { balanceCents: cashBalanceCents(d, profileId), entries, cashBills: listCashBills(d, profileId) }
    },
    /** Tips in the home currency (cents) or in a foreign one (converted at the rate the person typed). */
    addTip: (profileId: number, date: string, cents: number, note?: string, foreign?: { currency: string; cents: number; rate: number }) => addTip(open(), profileId, date, cents, note, foreign),
    fxRates: () => lastRates(open()),
    addCashSpend: (profileId: number, date: string, cents: number, description: string, categoryId: number, note?: string) => addCashSpend(open(), profileId, date, cents, description, categoryId, note),
    recordCashBill: (profileId: number, recurringId: number, date: string, categoryId: number) => recordCashBill(open(), profileId, recurringId, date, categoryId),
    depositCash: (profileId: number, date: string, cents: number, toAccountId: number) => depositCash(open(), profileId, date, cents, toAccountId),
    deleteCashEntry: (profileId: number, txnId: number) => deleteCashEntry(open(), profileId, txnId),

    /** Parses an uploaded statement (sent as base64) and returns an editable preview. Nothing is saved yet. */
    importPreview: (profileId: number, accountId: number, fileName: string, base64: string, options?: ParseOptions) => {
      const d = open()
      const bytes = Buffer.from(base64, 'base64')
      const rows = readStatementRows(fileName, bytes)
      const key = `import_columns_${accountId}`
      let parsed = parseStatement(rows, options)
      if (parsed.rows.length === 0 && !options?.columns) {
        // Not recognised automatically: try the column choice remembered for this account.
        const saved = (d.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined)?.value
        if (saved) { try { const columns = JSON.parse(saved); if (validColumnMap(columns)) parsed = parseStatement(rows, { ...options, columns }) } catch { /* ignore a damaged setting */ } }
      }
      if (parsed.rows.length === 0) throw new Error(parsed.warnings[0] ?? 'No transactions were found in that file.')
      if (options?.columns) d.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(options.columns)) // remembered for next time
      const meta: ImportMeta = { fileHash: hashFile(bytes), layout: layoutOf(rows), sameFileBefore: null }
      meta.sameFileBefore = previousImportOf(d, profileId, meta.fileHash)
      return { ...buildPreview(d, profileId, accountId, parsed, fileName), ...meta }
    },
    /** Which account does this file (or, with no file, this person's next import) most likely belong to? Null when there is no good guess. */
    importSuggest: (profileId: number, file?: { name: string; base64: string }) => {
      if (!file) return suggestAccount(open(), profileId, null)
      const bytes = Buffer.from(file.base64, 'base64')
      let layout = 'unknown'
      try { layout = layoutOf(readStatementRows(file.name, bytes)) } catch { /* unreadable files are reported by the preview */ }
      return suggestAccount(open(), profileId, { name: file.name, layout, hash: hashFile(bytes) })
    },
    /** The first lines of a file as plain cells, so the user can say which column is the date, description and amount. */
    importPeek: (fileName: string, base64: string) => {
      const rows = readStatementRows(fileName, Buffer.from(base64, 'base64'))
      return { rows: rows.slice(0, 8), columns: Math.max(0, ...rows.slice(0, 50).map((r) => r.length)) }
    },
    importCommit: (profileId: number, accountId: number, fileName: string, rows: CommitRow[], learnFromDuplicates: boolean, meta?: { fileHash?: string; layout?: string; allowOtherAccount?: boolean }) => commitImport(open(), profileId, accountId, fileName, rows, { learnFromDuplicates, fileHash: meta?.fileHash ?? null, layout: meta?.layout ?? null, allowOtherAccount: meta?.allowOtherAccount }),
    importHistory: (profileId: number) => listImports(open(), profileId),
    importUndo: (profileId: number, batchId: number) => undoImport(open(), profileId, batchId),

    budgets: (profileId: number, month: string) => budgetReport(open(), profileId, month, today()),
    budgetCreate: (profileId: number, name: string, monthlyCents: number, categoryIds: number[]) => createBudget(open(), profileId, name, monthlyCents, categoryIds),
    /** Averages of the last three complete months, per category, for categories not in a budget yet. Nothing is saved. */
    budgetSuggest: (profileId: number) => suggestBudgets(open(), profileId, today()),
    budgetCreateMany: (profileId: number, items: { name: string; monthlyCents: number; categoryIds: number[] }[]) => createBudgets(open(), profileId, items),
    budgetUpdate: (profileId: number, id: number, patch: { name?: string; monthlyCents?: number; categoryIds?: number[] }) => updateBudget(open(), profileId, id, patch),
    budgetDelete: (profileId: number, id: number) => deleteBudget(open(), profileId, id),

    goals: (profileId: number) => listGoals(open(), profileId, today()),
    goalCreate: (profileId: number, dto: GoalDto) => createGoal(open(), profileId, dto),
    /** Realistic goal ideas from recent income, spending, savings, cards and loans. Nothing is saved. */
    goalIdeas: (profileId: number) => goalIdeas(open(), profileId, today()),
    goalCreateFromIdeas: (profileId: number, picks: { key: string; name?: string; plannedMonthlyCents?: number | null }[]) => createGoalsFromIdeas(open(), profileId, picks, today()),
    /** The debt payoff planner. `edits` are unsaved changes, so the screen can update as the person types. */
    debtPlanner: (profileId: number, edits?: PlannerEdits) => getPlanner(open(), profileId, today(), edits),
    debtPlannerSave: (profileId: number, edits: PlannerEdits) => savePlanner(open(), profileId, edits, today()),
    debtPlannerReset: (profileId: number) => resetPlanner(open(), profileId, today()),
    /** The forecast: today's pace, the plan that follows budgets/goals/debt planner, and (if edited) the person's what-if. */
    forecast: (profileId: number, months?: number, whatIf?: WhatIf | null) => getForecast(open(), profileId, today(), { months, whatIf }),
    forecastSaveWhatIf: (profileId: number, whatIf: WhatIf | null) => saveWhatIf(open(), profileId, whatIf),
    goalUpdate: (profileId: number, id: number, dto: GoalDto) => updateGoal(open(), profileId, id, dto),
    goalDelete: (profileId: number, id: number) => deleteGoal(open(), profileId, id),

    debtCreate: (profileId: number, name: string, balanceCents: number, asOf: string, notes?: string) => createDebt(open(), profileId, name, balanceCents, asOf, notes),
    debtUpdate: (profileId: number, debtId: number, balanceCents: number, asOf: string) => updateDebtBalance(open(), profileId, debtId, balanceCents, asOf),
    debtHistory: (profileId: number, debtId: number) => debtHistory(open(), profileId, debtId),

    monthlyReview: (profileId: number, month?: string) => getMonthlyReview(open(), profileId, month, today()),

    /** Facts for the About box and for troubleshooting. Nothing sensitive: no balances, no names. */
    diagnostics: () => {
      const d = open()
      const file = dbPath()
      return {
        version: process.env.FINANCE_APP_VERSION ?? 'dev',
        platform: process.platform,
        dbPath: file,
        dbSizeBytes: file === ':memory:' ? 0 : fs.statSync(file).size,
        schemaVersion: d.pragma('user_version', { simple: true }) as number,
        transactions: (d.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n,
        backupDir: path.join(dataDir, 'backups'),
        sample: sampleActive()
      }
    },
    /** A consistent copy of the whole database (safe even while the app is running). */
    backupNow: () => backup(),

    // ---- accounts: add, rename, close, share ----
    accountCreate: (profileId: number, a: NewAccount) => createAccount(open(), profileId, a),
    accountSetLimit: (profileId: number, id: number, limitCents: number | null) => setCreditLimit(open(), profileId, id, limitCents),
    accountRename: (profileId: number, id: number, name: string) => renameAccount(open(), profileId, id, name),
    accountClose: (profileId: number, id: number, confirmBalance?: boolean) => closeAccount(open(), profileId, id, { confirmBalance }),
    accountReopen: (profileId: number, id: number) => reopenAccount(open(), profileId, id),
    /** Makes an account shared (moves it to the household) or gives it back to a person. One side must be the household. */
    accountMove: (accountId: number, toProfileId: number) => {
      const d = open()
      const from = d.prepare('SELECT p.kind FROM account a JOIN profile p ON p.id = a.profile_id WHERE a.id = ?').get(accountId) as { kind: string } | undefined
      const to = d.prepare('SELECT kind FROM profile WHERE id = ?').get(toProfileId) as { kind: string } | undefined
      if (!from || !to) throw new Error('That account or person no longer exists. Reload the page.')
      if (from.kind === 'person' && to.kind === 'person') throw new Error('An account is either personal or shared. To move it between you, make it shared first.')
      return moveAccount(d, accountId, toProfileId)
    },
    partnerAliases: (profileId: number) => getPartnerAliases(open(), profileId),
    setPartnerAliases: (profileId: number, names: string[]) => setPartnerAliases(open(), profileId, names),

    // ---- household (combined) view ----
    householdOverview: (month?: string) => getHouseholdOverview(open(), month),
    householdAccounts: () => listHouseholdAccounts(open()),
    householdTxns: (filter: TxnFilter) => queryTxns(open(), listOwners(open()).map((o) => o.profileId), filter),
    householdBudgets: (month: string) => ({ budgets: listHouseholdBudgets(open()), report: householdBudgetReport(open(), month) }),
    householdBudgetCreate: (name: string, monthlyCents: number, groups: string[]) => createHouseholdBudget(open(), name, monthlyCents, groups),
    householdBudgetSuggest: () => suggestHouseholdBudgets(open(), today()),
    householdBudgetCreateMany: (items: { name: string; monthlyCents: number; groups: string[] }[]) => createHouseholdBudgets(open(), items),
    householdBudgetUpdate: (id: number, patch: { name?: string; monthlyCents?: number; groups?: string[] }) => updateHouseholdBudget(open(), id, patch),
    householdBudgetDelete: (id: number) => deleteHouseholdBudget(open(), id),
    householdGoals: () => listHouseholdGoals(open(), today()),
    categoryGroups: () => listCategoryGroups(open()),
    groupNames: () => listGroupNames(open()),
    setCategoryGroup: (categoryId: number, group: string | null) => setCategoryGroup(open(), categoryId, group),

    close: () => { db?.close(); db = null }
  }
}

export type Handlers = ReturnType<typeof createHandlers>
export type ApiMethod = keyof Handlers
