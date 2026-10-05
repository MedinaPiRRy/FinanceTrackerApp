// Dates are ISO strings (YYYY-MM-DD) everywhere. No timezone math on money data.

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function assertIso(d: string): string {
  if (!ISO.test(d)) throw new Error(`Not an ISO date: ${d}`)
  return d
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${assertIso(iso)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return toIso(d)
}

export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${assertIso(b)}T00:00:00Z`) - Date.parse(`${assertIso(a)}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/** "2026-09-14" -> "2026-09" */
export function monthKey(iso: string): string {
  return assertIso(iso).slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

export function monthRange(month: string): { from: string; to: string } {
  const next = addMonths(month, 1)
  return { from: `${month}-01`, to: addDays(`${next}-01`, -1) }
}
