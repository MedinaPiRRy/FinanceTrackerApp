// Which tab of the Review page a waiting transaction belongs to. Pure, so the UI and the database agree.
import { addDays } from './dates'

export type ReviewTab = 'possible_income' | 'money_in' | 'money_out' | 'other' | 'older'

/** A waiting transaction older than this many days is "older": it is set aside instead of being pushed at the person. */
export const OLD_AFTER_DAYS = 90

export const REVIEW_TABS: { tab: ReviewTab; label: string; hint: string }[] = [
  { tab: 'possible_income', label: 'Possible income', hint: 'Money that came in and the app cannot tell what it was: e-transfers received, deposits, unknown credits. Decide whether each source is income, a reimbursement or something else.' },
  { tab: 'money_in', label: 'Money in', hint: 'Other money coming in that needs a category or a second look.' },
  { tab: 'money_out', label: 'Money out', hint: 'Money that went out and needs a category or a decision (e-transfers sent, withdrawals).' },
  { tab: 'other', label: 'Transfers & investments', hint: 'Money moved to or from an investment or another account.' },
  { tab: 'older', label: 'Older', hint: 'Waiting for longer than your chosen number of days (Settings → General), so they are not highlighted anywhere and not counted in your figures yet. Review them whenever you like; the same grouping and "always do this" apply.' }
]

export interface TabInput { amountCents: number; kind: string; reason: string; date: string }

/** The first day that still counts as recent (anything before it is older). */
export const recentFrom = (today: string, days: number = OLD_AFTER_DAYS): string => addDays(today, -days)

/** Rows about moving money between accounts or into investments, in either direction. */
const MOVEMENT = /investment|transfer with no destination/i

export function reviewTabOf(i: TabInput, today: string, days: number = OLD_AFTER_DAYS): ReviewTab {
  if (i.date < recentFrom(today, days)) return 'older'
  if (MOVEMENT.test(i.reason)) return 'other'
  if (i.amountCents > 0) return i.kind === 'unclassified' ? 'possible_income' : 'money_in'
  return 'money_out'
}
