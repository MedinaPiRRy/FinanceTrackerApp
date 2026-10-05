import type { PlanDebt } from '../core/debtPlan'
import type { PlannerState } from './debtPlan'

/** The debts of a planner state in the shape the pure planner and forecast use. */
export const toPlanDebts = (p: PlannerState): PlanDebt[] =>
  p.debts.map((d) => ({ id: d.key, label: d.owner ? `${d.label} (${d.owner})` : d.label, balanceCents: d.balanceCents, aprBps: d.aprBps, minPaymentCents: d.minPaymentCents }))
