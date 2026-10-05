import { addMonths, daysBetween, monthKey } from './dates'

export type GoalKind = 'manual' | 'account' | 'category' | 'debt'

export interface GoalInput {
  kind: GoalKind
  targetCents: number
  /**
   * Progress so far in cents: money saved/spent toward the target. For debt goals this is how much has been paid off
   * (start amount minus what is owed now). null = no value yet (e.g. an investment account never valued).
   */
  achievedCents: number | null
  /** Debt goals only: what is still owed right now (can exceed the starting amount if more was borrowed). */
  owedCents?: number
  deadline: string | null // ISO date
  plannedMonthlyCents: number | null
  today: string // ISO date
}

export type GoalStatus = 'achieved' | 'on_track' | 'behind' | 'overdue' | 'no_deadline' | 'no_value'

export interface GoalProgress {
  achievedCents: number | null
  remainingCents: number
  /** 0..1 (can exceed 1 when a minimum target is beaten, e.g. "at least $60,000"). */
  progress: number
  /** What must be put in each month to finish by the deadline; null without a deadline. */
  requiredMonthlyCents: number | null
  /** Month (YYYY-MM) of the last needed payment at the planned monthly amount, starting this month; null if unknown. */
  estimatedMonth: string | null
  monthsToGo: number | null
  status: GoalStatus
}

/** Whole months from today's month to the deadline's month, counting the current month as one. Never below 1. */
export function monthsUntil(deadline: string, today: string): number {
  const [ty, tm] = monthKey(today).split('-').map(Number) as [number, number]
  const [dy, dm] = monthKey(deadline).split('-').map(Number) as [number, number]
  return Math.max(1, (dy - ty) * 12 + (dm - tm) + 1)
}

export function computeGoal(i: GoalInput): GoalProgress {
  const remaining = i.kind === 'debt' ? Math.max(0, i.owedCents ?? i.targetCents) : Math.max(0, i.targetCents - (i.achievedCents ?? 0))
  const progress = i.kind === 'debt' ? (i.targetCents > 0 ? Math.min(1, Math.max(0, (i.achievedCents ?? 0) / i.targetCents)) : 0) : i.achievedCents === null ? 0 : i.achievedCents / i.targetCents

  if (i.achievedCents === null && i.kind !== 'debt') {
    return { achievedCents: null, remainingCents: i.targetCents, progress: 0, requiredMonthlyCents: null, estimatedMonth: null, monthsToGo: null, status: 'no_value' }
  }
  if (remaining === 0) return { achievedCents: i.achievedCents, remainingCents: 0, progress: Math.max(progress, 1), requiredMonthlyCents: 0, estimatedMonth: monthKey(i.today), monthsToGo: 0, status: 'achieved' }

  const overdue = i.deadline !== null && daysBetween(i.today, i.deadline) < 0
  const required = i.deadline === null ? null : overdue ? remaining : Math.ceil(remaining / monthsUntil(i.deadline, i.today))
  const planned = i.plannedMonthlyCents && i.plannedMonthlyCents > 0 ? i.plannedMonthlyCents : null
  const monthsToGo = planned ? Math.ceil(remaining / planned) : null
  // contributions start this month, so N payments finish in the Nth month counting this one
  const estimatedMonth = monthsToGo !== null ? addMonths(monthKey(i.today), monthsToGo - 1) : null

  let status: GoalStatus
  if (overdue) status = 'overdue'
  else if (i.deadline === null) status = 'no_deadline'
  else if (estimatedMonth === null) status = 'behind' // a deadline exists but nothing is planned to reach it
  else status = estimatedMonth <= monthKey(i.deadline) ? 'on_track' : 'behind'

  return { achievedCents: i.achievedCents, remainingCents: remaining, progress, requiredMonthlyCents: required, estimatedMonth, monthsToGo, status }
}
