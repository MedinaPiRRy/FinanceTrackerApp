import { monthLabel } from '../core/insights'

export { formatCents } from '../core/money'
export { monthLabel }

export const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

export function shortMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1]} ${String(y).slice(2)}`
}

export const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`)

export const KIND_LABEL: Record<string, string> = { income: 'Income', expense: 'Expense', refund: 'Refund', transfer: 'Transfer', unclassified: 'Needs review' }

export const ACCOUNT_TYPE_LABEL: Record<string, string> = { chequing: 'Chequing', savings: 'Savings', credit_card: 'Credit card', cash: 'Cash', investment: 'Investment', loan: 'Loan', other: 'Other' }

export const profileLabel = (p: { slug: string; name: string }) => p.name
