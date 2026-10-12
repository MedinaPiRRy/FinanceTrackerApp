// The "Month by month" table of the Forecast page, as plain data so it can be tested without a screen.
import type { ForecastCase } from './forecast'

export type ScenarioName = 'current' | 'plan' | 'whatif'

/** The part of a forecast the table needs (the forecast view from the database has this shape). */
export interface ScenarioSource {
  current: { expected: ForecastCase }
  plan: { expected: ForecastCase }
  whatIf: { expected: ForecastCase } | null
}

export interface MonthRow {
  month: string
  incomeCents: number
  expenseCents: number
  goalCents: number
  debtPaidCents: number
  interestCents: number
  cashCents: number
  debtCents: number
}

/** The scenario to show: the wanted one, or the plan when the what-if the person had picked no longer exists. */
export function activeScenario(view: ScenarioSource, wanted: ScenarioName): ScenarioName {
  return wanted === 'whatif' && !view.whatIf ? 'plan' : wanted
}

export function monthByMonth(view: ScenarioSource, wanted: ScenarioName): { scenario: ScenarioName; rows: MonthRow[] } {
  const scenario = activeScenario(view, wanted)
  const c = scenario === 'whatif' ? view.whatIf!.expected : scenario === 'current' ? view.current.expected : view.plan.expected
  return { scenario, rows: c.months.map((m) => ({ month: m.month, incomeCents: m.incomeCents, expenseCents: m.expenseCents, goalCents: m.goalCents, debtPaidCents: m.debtPaidCents, interestCents: m.interestCents, cashCents: m.cashCents, debtCents: m.debtCents })) }
}
