// All money in the app is integer cents (CAD). Never store or sum floats.

export function toCents(n: number): number {
  return Math.round(Number((n * 100).toFixed(4)))
}

/** Parses "1,234.50", "-12", "(12.00)", "$5" into cents. Returns null if not a number. */
export function parseMoneyToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') return Number.isFinite(input) ? toCents(input) : null
  let s = input.trim()
  if (s === '') return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[$,\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const cents = toCents(Number(s))
  return negative ? -cents : cents
}

export function formatCents(cents: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(cents) / 100
  const body = abs.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })
  if (cents < 0) return `-${body}`
  return opts.sign && cents > 0 ? `+${body}` : body
}
