// The debt payoff planner: reads cards and loans, applies the interest rates and minimums the person entered (or sensible
// defaults), and compares strategies. The numbers come from core/debtPlan.
import type { Db } from './open'
import { addMonths, monthKey } from '../core/dates'
import { planPayoff, defaultBudget, defaultMinPayment, DEFAULT_CARD_APR_BPS, type PayoffResult, type PlanDebt, type Strategy } from '../core/debtPlan'
import { accountValueCents } from './review'
import { listOwners } from './household'
import { listGoals } from './goals'
import { recentAverages } from './averages'

export interface PlannerDebt {
  /** "card:12" (account id) or "loan:3" (debt id). */
  key: string
  kind: 'card' | 'loan'
  refId: number
  label: string
  /** Whose it is, shown in the household view. */
  owner: string | null
  balanceCents: number
  aprBps: number
  minPaymentCents: number
  aprIsDefault: boolean
  minIsDefault: boolean
}

export interface PlannerState {
  debts: PlannerDebt[]
  strategy: Strategy
  monthlyBudgetCents: number
  budgetIsDefault: boolean
  /** Average left over each month (income minus spending), if there is enough history. */
  surplusCents: number | null
  /** What is left after the money planned for savings goals: the default monthly amount is 60% of this. */
  surplusAfterGoalsCents: number | null
  startMonth: string
  results: { chosen: PayoffResult; minimum: PayoffResult; avalanche: PayoffResult; snowball: PayoffResult }
}

export interface PlannerEdits {
  terms?: { key: string; aprBps?: number; minPaymentCents?: number }[]
  strategy?: Strategy
  /** null = use the default. */
  monthlyBudgetCents?: number | null
}

const STRATEGIES: Strategy[] = ['avalanche', 'snowball', 'minimum']
const settingKey = (profileId: number) => `debt_plan_${profileId}`

function savedPlan(db: Db, profileId: number): { strategy: Strategy; monthlyBudgetCents: number | null } {
  const raw = (db.prepare('SELECT value FROM setting WHERE key = ?').get(settingKey(profileId)) as { value: string } | undefined)?.value
  try {
    const v = JSON.parse(raw ?? '{}') as { strategy?: Strategy; monthlyBudgetCents?: number | null }
    return { strategy: STRATEGIES.includes(v.strategy as Strategy) ? (v.strategy as Strategy) : 'avalanche', monthlyBudgetCents: typeof v.monthlyBudgetCents === 'number' && v.monthlyBudgetCents >= 0 ? v.monthlyBudgetCents : null }
  } catch { return { strategy: 'avalanche', monthlyBudgetCents: null } }
}

/** The profiles whose debts count: a person's own, or everyone's for the household. */
export function scopeOf(db: Db, profileId: number): { ids: number[]; household: boolean } {
  const p = db.prepare('SELECT kind FROM profile WHERE id = ?').get(profileId) as { kind: string } | undefined
  if (!p) throw new Error('That person no longer exists. Reload the page.')
  return p.kind === 'household' ? { ids: listOwners(db).map((o) => o.profileId), household: true } : { ids: [profileId], household: false }
}

export function loadPlannerDebts(db: Db, profileId: number): PlannerDebt[] {
  const { ids, household } = scopeOf(db, profileId)
  const marks = ids.map(() => '?').join(',')
  const terms = new Map((db.prepare('SELECT kind, ref_id, apr_bps, min_payment_cents FROM debt_terms').all() as { kind: string; ref_id: number; apr_bps: number | null; min_payment_cents: number | null }[]).map((t) => [`${t.kind}:${t.ref_id}`, t]))
  const out: PlannerDebt[] = []
  const cards = db.prepare(`SELECT a.id, a.name, p.name AS owner FROM account a JOIN profile p ON p.id = a.profile_id WHERE a.profile_id IN (${marks}) AND a.type = 'credit_card' AND a.archived = 0 ORDER BY a.id`).all(...ids) as { id: number; name: string; owner: string }[]
  for (const c of cards) {
    const owed = Math.max(0, -(accountValueCents(db, c.id) ?? 0))
    if (owed <= 0) continue
    const t = terms.get(`card:${c.id}`)
    out.push({ key: `card:${c.id}`, kind: 'card', refId: c.id, label: c.name, owner: household ? c.owner : null, balanceCents: owed,
      aprBps: t?.apr_bps ?? DEFAULT_CARD_APR_BPS, aprIsDefault: t?.apr_bps == null, minPaymentCents: t?.min_payment_cents ?? defaultMinPayment(owed, 'card'), minIsDefault: t?.min_payment_cents == null })
  }
  const loans = db.prepare(`SELECT d.id, d.name, d.balance_cents AS b, p.name AS owner FROM debt d JOIN profile p ON p.id = d.profile_id WHERE d.profile_id IN (${marks}) AND d.balance_cents > 0 ORDER BY d.id`).all(...ids) as { id: number; name: string; b: number; owner: string }[]
  for (const l of loans) {
    const t = terms.get(`loan:${l.id}`)
    out.push({ key: `loan:${l.id}`, kind: 'loan', refId: l.id, label: l.name, owner: household ? l.owner : null, balanceCents: l.b,
      aprBps: t?.apr_bps ?? 0, aprIsDefault: t?.apr_bps == null, minPaymentCents: t?.min_payment_cents ?? defaultMinPayment(l.b, 'loan'), minIsDefault: t?.min_payment_cents == null })
  }
  return out
}

const toPlan = (d: PlannerDebt): PlanDebt => ({ id: d.key, label: d.owner ? `${d.label} (${d.owner})` : d.label, balanceCents: d.balanceCents, aprBps: d.aprBps, minPaymentCents: d.minPaymentCents })

/** Everything the planner shows. `edits` are the person's unsaved changes, applied on top of what is saved so the screen updates live. */
export function getPlanner(db: Db, profileId: number, today: string, edits: PlannerEdits = {}): PlannerState {
  const { ids } = scopeOf(db, profileId)
  const saved = savedPlan(db, profileId)
  let debts = loadPlannerDebts(db, profileId)
  for (const t of edits.terms ?? []) {
    debts = debts.map((d) => d.key !== t.key ? d : { ...d, aprBps: t.aprBps ?? d.aprBps, aprIsDefault: t.aprBps !== undefined ? false : d.aprIsDefault, minPaymentCents: t.minPaymentCents ?? d.minPaymentCents, minIsDefault: t.minPaymentCents !== undefined ? false : d.minIsDefault })
  }
  const avg = recentAverages(db, ids, today)
  const surplus = avg.income !== null && avg.spend !== null ? avg.income - avg.spend : null
  // money already planned for savings goals is not available for debts as well
  const allGoals = ids.flatMap((i) => listGoals(db, i, today))
  const savingPlanned = allGoals.filter((g) => (g.kind === 'manual' || g.kind === 'account') && g.progress.remainingCents > 0).reduce((a, g) => a + (g.plannedMonthlyCents ?? 0), 0)
  const surplusForDebt = surplus === null ? null : surplus - savingPlanned
  const plan = debts.map(toPlan)
  // A debt goal with a planned monthly amount is the person's own intention: never plan to pay less than that.
  const goalPlanned = allGoals.filter((g) => g.kind === 'debt').reduce((s, g) => s + (g.plannedMonthlyCents ?? 0), 0)
  const defBudget = Math.max(defaultBudget(plan, surplusForDebt), Math.min(goalPlanned, plan.reduce((s, d) => s + d.balanceCents, 0)))
  const strategy = edits.strategy ?? saved.strategy
  const chosenBudget = edits.monthlyBudgetCents !== undefined ? edits.monthlyBudgetCents : saved.monthlyBudgetCents
  const budget = chosenBudget ?? defBudget
  const startMonth = addMonths(monthKey(today), 1)
  const run = (s: Strategy) => planPayoff(plan, { strategy: s, monthlyBudgetCents: budget, startMonth })
  return {
    debts, strategy, monthlyBudgetCents: budget, budgetIsDefault: chosenBudget === null, surplusCents: surplus, surplusAfterGoalsCents: surplusForDebt, startMonth,
    results: { chosen: run(strategy), minimum: run('minimum'), avalanche: run('avalanche'), snowball: run('snowball') }
  }
}

/** Saves interest rates, minimums, strategy and monthly amount. Validates everything; a bad value changes nothing. */
export function savePlanner(db: Db, profileId: number, edits: PlannerEdits, today: string): PlannerState {
  const known = new Set(loadPlannerDebts(db, profileId).map((d) => d.key))
  for (const t of edits.terms ?? []) {
    if (!known.has(t.key)) throw new Error('That debt is not part of this plan')
    if (t.aprBps !== undefined && (!Number.isInteger(t.aprBps) || t.aprBps < 0 || t.aprBps > 10000)) throw new Error('The interest rate must be between 0% and 100%')
    if (t.minPaymentCents !== undefined && (!Number.isInteger(t.minPaymentCents) || t.minPaymentCents < 0)) throw new Error('The minimum payment cannot be negative')
  }
  if (edits.strategy !== undefined && !STRATEGIES.includes(edits.strategy)) throw new Error('Choose one of the payoff orders from the list.')
  if (edits.monthlyBudgetCents != null && (!Number.isInteger(edits.monthlyBudgetCents) || edits.monthlyBudgetCents < 0)) throw new Error('The monthly amount cannot be negative')
  db.transaction(() => {
    for (const t of edits.terms ?? []) {
      const [kind, ref] = t.key.split(':') as ['card' | 'loan', string]
      db.prepare(`INSERT INTO debt_terms (kind, ref_id, apr_bps, min_payment_cents) VALUES (?,?,?,?)
        ON CONFLICT(kind, ref_id) DO UPDATE SET apr_bps = COALESCE(?, apr_bps), min_payment_cents = COALESCE(?, min_payment_cents)`)
        .run(kind, Number(ref), t.aprBps ?? null, t.minPaymentCents ?? null, t.aprBps ?? null, t.minPaymentCents ?? null)
    }
    const cur = savedPlan(db, profileId)
    const next = { strategy: edits.strategy ?? cur.strategy, monthlyBudgetCents: edits.monthlyBudgetCents !== undefined ? edits.monthlyBudgetCents : cur.monthlyBudgetCents }
    db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(settingKey(profileId), JSON.stringify(next))
  })()
  return getPlanner(db, profileId, today)
}

/** Forgets the saved choices so the defaults apply again. Interest rates and minimums are kept. */
export function resetPlanner(db: Db, profileId: number, today: string): PlannerState {
  db.prepare('DELETE FROM setting WHERE key = ?').run(settingKey(profileId))
  return getPlanner(db, profileId, today)
}
