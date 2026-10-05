// Deterministic first-pass classification of a statement line. No AI, no guessing about people:
// anything that depends on WHY the money moved is sent to the review queue instead.

export type Kind = 'income' | 'expense' | 'refund' | 'transfer' | 'unclassified'
export type Tag = 'dining' | 'groceries' | 'transport' | 'subscriptions' | 'health' | 'shopping' | 'fees'

export interface Classification {
  kind: Kind
  /** Non-null = this row goes to the review queue with this explanation. */
  reviewReason: string | null
  /** Hint for the built-in category keywords (e.g. bank fees). */
  tag: Tag | null
  /** True when the row should get an expense/income/refund category. */
  needsCategory: boolean
}

const R = (kind: Kind, reviewReason: string | null = null, tag: Tag | null = null, needsCategory = false): Classification => ({ kind, reviewReason, tag, needsCategory })

const BUILTIN: [Tag, RegExp][] = [
  ['dining', /MCDONALD|TIM HORTON|WENDY|POPEYES|STARBUCKS|SUBWAY|PIZZA|SHAWARMA|BURGER|A&W|DOMINO|KFC|DAIRY QUEEN|FIVE GUYS|HARVEY|DOORDASH|SKIP\*|SKIPTHE|UBER \*?EATS|RESTAURANT|CAFE|COFFEE|GRILL|SUSHI|TACO/],
  ['groceries', /RABBA|METRO|SOBEYS|NO FRILLS|NOFRILLS|LOBLAWS|FRESHCO|FOOD BASICS|COSTCO|WAL-MART|WALMART|GIANT TIGER|FARM BOY|BULK BARN|DOLLARAMA|GROCER|SUPERMARKET/],
  ['transport', /PETRO-?CANADA|SHELL|ESSO|CIRCLE K|MOBIL|PIONEER|ULTRAMAR|SUNOCO|PRESTO|GO TVM|TTC|UBER(?! ?EATS)|LYFT|PARKING|HONK|PARK INDIGO|407 ETR/],
  ['subscriptions', /SPOTIFY|NETFLIX|YOUTUBE|APPLE\.COM\/BILL|ICLOUD|DISNEY|AMAZON PRIME|PRIME VIDEO|GOOGLE ?\*?ONE|PLAYSTATION|XBOX|NINTENDO|DASHPASS|GITHUB|ANTHROPIC|OPENAI|CHATGPT|ADOBE|MICROSOFT/],
  ['health', /SHOPPERS|PHARM|DRUG MART|DENTAL|DENTIST|CLINIC|OPTICAL|HEALTH/],
  ['shopping', /AMAZON|AMZN|SEPHORA|WINNERS|H&M|ZARA|ABERCROMBIE|BEST BUY|IKEA|HOME DEPOT/],
  ['fees', /INTEREST|OVERLIMIT|SERVICE CHARGE|MONTHLY FEE|ANNUAL FEE|NSF|OVERDRAFT/]
]

export function builtinTag(key: string): Tag | null {
  for (const [tag, re] of BUILTIN) if (re.test(key)) return tag
  return null
}

const FEE = /SERVICE CHARGE|OVERDRAFT|OVERLIMIT|ANNUAL FEE|MONTHLY FEE|PURCHASE INTEREST|CASH ADVANCE INTEREST|INTEREST CHARGE|NSF FEE|E-TRANSFER FEE/

export function classifyRow(accountType: string, rawDescription: string, amountCents: number): Classification {
  const d = rawDescription.toUpperCase()
  const moneyIn = amountCents > 0
  const card = accountType === 'credit_card'

  // ---- credit card lines ----
  if (card) {
    if (moneyIn && /PAYMENT THANK YOU|PAIEMENT|PAYMENT - THANK|PAYMENT RECEIVED/.test(d)) return R('transfer')
    if (/INTEREST REVERSAL|FEE REVERSAL|FEE REBATE/.test(d)) return R('refund', null, 'fees', true)
    if (!moneyIn && FEE.test(d)) return R('expense', null, 'fees', true)
    if (moneyIn) return R('refund', null, null, true) // a credit on a card that isn't a payment: refund of a purchase
    return R('expense', null, null, true)
  }

  // ---- chequing / savings lines ----
  if (/E-?TRANSFER/.test(d)) {
    // Why someone sent or received money varies, so the user always decides.
    return R('unclassified', `E-transfer ${moneyIn ? 'received' : 'sent'}: what was it for? (income, reimbursement, loan, transfer...)`)
  }
  if (/INTERNET TRANSFER.*\bTO CARD\b/.test(d)) return R('transfer')
  if (/INTERNET TRANSFER.*\b(FROM|TO) ACCOUNT\b/.test(d)) return R('transfer')
  if (/MEMO - INVESTMENT|DISATF|INVESTMENT/.test(d)) return R('unclassified', 'Money moved to or from an investment or another account: which one?')
  if (/INTERNET TRANSFER\s+\d+\s*$/.test(d)) return R('unclassified', 'Transfer with no destination shown: where did the money go or come from?')
  if (/SERVICE CHARGE DISCOUNT|FEE REBATE|FEE REVERSAL/.test(d)) return R('refund', null, 'fees', true)
  if (!moneyIn && FEE.test(d)) return R('expense', null, 'fees', true)
  if (/ATM (DEPOSIT|WITHDRAWAL)/.test(d)) return R('unclassified', `ATM ${moneyIn ? 'deposit' : 'withdrawal'}: tips, cash for spending, or a transfer?`)
  if (/INTERNET DEPOSIT|MOBILE DEPOSIT|BRANCH.*DEPOSIT|DEPOSIT/.test(d) && moneyIn) return R('unclassified', 'Deposit: where did this money come from?')
  if (moneyIn && /ELECTRONIC FUNDS TRANSFER PAY\b|PAYROLL|DIRECT DEPOSIT/.test(d)) return R('income', null, null, true)
  if (moneyIn && /GOVERNMENT|CANADA|CRA\b|GST|CCB/.test(d)) return R('income', null, null, true)
  if (moneyIn) return R('unclassified', 'Money received: what was it?')
  return R('expense', null, null, true)
}
