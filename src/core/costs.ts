// What counts as "taxes" and "interest" on the Taxes & interest page. Pure, so the page and the tests agree.
//
// Money can count on either side of each: PAID (a tax bill, interest charged) and RECEIVED (a GST/HST credit or a government benefit that is part of
// your taxes, interest earned). Which side is decided by the direction of the money, not by the label.

export type Purpose = 'tax' | 'interest' | 'none'
export type CostSide = 'paid' | 'received'
/** Why a payment counts: the person marked this payment, its category is marked (or named) that way, or its own words say interest. */
export type CostWhy = 'marked' | 'category' | 'wording'

/** A guess from a category's name, used until the person sets the category's purpose themselves. */
export function guessPurpose(name: string): Purpose {
  if (/\b(income tax|property tax|sales tax|taxes|tax|hst|gst|pst|cra|revenue agency)\b/i.test(name)) return 'tax'
  // A category that is about fees as well ("Bank Fees & Interest") is not guessed: most of what is in it is fees, so each line counts as interest
  // only when its own words say so (see looksLikeInterest). The person can still mark such a category as Interest.
  if (/\binterest\b/i.test(name) && !/\b(fees?|charges?|service)\b/i.test(name)) return 'interest'
  return 'none'
}

/** Money going out whose own words say it is interest: "PURCHASE INTEREST", "OVERDRAFT INTEREST", "LOAN INTEREST". */
export const looksLikeInterest = (text: string): boolean => /\binterest\b/i.test(text) && !/\b(refund|reversal|rebate|credit)\b/i.test(text) && !/\b(no|zero|0%)[\s-]+interest\b|\binterest[\s-]+free\b|\bwaived\b/i.test(text)

export interface CostRow {
  kind: string
  amountCents: number
  description: string
  categoryPurpose: Purpose | null
  categoryName: string | null
  /** What the person chose for this one payment: 'tax' or 'interest' to count it, 'none' to leave it out, null to decide automatically. */
  markedPurpose?: Purpose | null
  /** The payment's account was taken out of this page. */
  accountExcluded?: boolean
}

export interface CostClass { kind: 'tax' | 'interest'; side: CostSide; why: CostWhy }

/**
 * What one transaction counts as, if anything. In order:
 *  1. a mark on the payment itself ('tax' or 'interest' counts it, 'none' leaves it out) beats everything;
 *  2. a payment in an account the person removed from this page is left out;
 *  3. its category's setting (or, if never set, a guess from the category's name);
 *  4. failing that, an expense whose own words say interest.
 * Transfers are movement between your accounts, never counted. Money coming in counts on the received side; refunds reduce what was paid.
 */
export function classifyCost(r: CostRow): CostClass | null {
  if (r.kind !== 'expense' && r.kind !== 'refund' && r.kind !== 'income') return null
  const side: CostSide = r.kind === 'income' ? 'received' : 'paid'
  if (r.markedPurpose === 'tax' || r.markedPurpose === 'interest') return { kind: r.markedPurpose, side, why: 'marked' }
  if (r.markedPurpose === 'none') return null
  if (r.accountExcluded) return null
  const purpose = r.categoryPurpose ?? (r.categoryName ? guessPurpose(r.categoryName) : 'none')
  if (purpose === 'tax' || purpose === 'interest') return { kind: purpose, side, why: 'category' }
  if (r.categoryPurpose === null && r.kind !== 'income' && looksLikeInterest(r.description)) return { kind: 'interest', side, why: 'wording' }
  return null
}

/** Kept for callers that only need the kind: taxes or interest on the paid side (and what refunds take off it). */
export function costKind(r: CostRow): 'tax' | 'interest' | null {
  const c = classifyCost(r)
  return c && c.side === 'paid' ? c.kind : null
}
