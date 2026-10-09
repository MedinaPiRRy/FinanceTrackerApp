// What counts as "taxes" and "interest" on the Taxes & interest page. Pure, so the page and the tests agree.

export type Purpose = 'tax' | 'interest' | 'none'

/** A guess from a category's name, used until the person sets the category's purpose themselves. */
export function guessPurpose(name: string): Purpose {
  if (/\b(income tax|property tax|sales tax|taxes|tax|hst|gst|pst|cra|revenue agency)\b/i.test(name)) return 'tax'
  if (/\binterest\b/i.test(name)) return 'interest'
  return 'none'
}

/** Money going out whose own words say it is interest: "PURCHASE INTEREST", "OVERDRAFT INTEREST", "LOAN INTEREST". */
export const looksLikeInterest = (text: string): boolean => /\binterest\b/i.test(text) && !/\b(refund|reversal|rebate|credit)\b/i.test(text)

export interface CostRow { kind: string; amountCents: number; description: string; categoryPurpose: Purpose | null; categoryName: string | null }

/**
 * What one transaction counts as. A category's own setting (or, if it was never set, a guess from its name) decides; a category set to
 * "none" is left alone. Failing that, an expense whose description says interest is interest. Refunds count against the same side.
 */
export function costKind(r: CostRow): 'tax' | 'interest' | null {
  if (r.kind !== 'expense' && r.kind !== 'refund') return null
  const purpose = r.categoryPurpose ?? (r.categoryName ? guessPurpose(r.categoryName) : 'none')
  if (purpose === 'tax' || purpose === 'interest') return purpose
  if (r.categoryPurpose === null && looksLikeInterest(r.description)) return 'interest'
  return null
}
