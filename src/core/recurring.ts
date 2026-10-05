export type Frequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly' | 'irregular'

/** Occurrences per month. Exact fractions, not the rounded 2.166667 used in the spreadsheets. */
const PER_MONTH: Record<Exclude<Frequency, 'irregular'>, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12
}

export function monthlyCostCents(amountCents: number, frequency: Frequency): number {
  if (frequency === 'irregular') return 0
  return Math.round(amountCents * PER_MONTH[frequency])
}

export function annualCostCents(amountCents: number, frequency: Frequency): number {
  return monthlyCostCents(amountCents, frequency) * 12
}
