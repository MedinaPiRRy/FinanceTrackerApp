// Turns a raw bank description into a stable "merchant key" so the same store always produces the same key,
// whatever its store number, city, reference number or the bank's channel wording.

const PROVINCE = /,?\s+(ON|BC|QC|NS|MB|AB|SK|NB|PE|PEI|NL|YT|NT|NU)$/

// "Point of Sale - Interac RETAIL PURCHASE <ref> MERCHANT", "Electronic Funds Transfer PREAUTHORIZED DEBIT <ref> PAYEE", ...
const CHANNEL_PREFIXES: RegExp[] = [
  /^POINT OF SALE - [A-Z ]*?(?:RETAIL PURCHASE|RETAIL REFUND|PURCHASE)\s+/,
  /^ELECTRONIC FUNDS TRANSFER PREAUTHORIZED DEBIT\s+/,
  /^ELECTRONIC FUNDS TRANSFER PAY\s+\d+\s+\d+\s+/, // payroll: reference number, then the pay-stub number
  /^ELECTRONIC FUNDS TRANSFER PAY\s+/,
  /^INTERNET BANKING E-TRANSFER\s+/,
  /^INTERNET BANKING INTERNET BILL PAY\s+/,
  /^INTERNET BANKING INTERNET TRANSFER\s+/,
  /^INTERNET BANKING INTERNET DEPOSIT\s+/,
  /^AUTOMATED BANKING MACHINE\s+/,
  /^BRANCH TRANSACTION\s+/
]

const isRef = (t: string) => (t.match(/\d/g) ?? []).length >= 4 && /^[A-Z0-9]{8,}$/.test(t) // e.g. 626712252659, 3J5HG8UJ0000, C02759020324 (but not FIT4LESS)
const isStoreToken = (t: string) => /^#?\d+$/.test(t) || /^\d{3}-\d{3}-\d{4}$/.test(t) || /^(?=(?:.*\d){2})[A-Z0-9]{4,}$/.test(t) || /^[A-Z]\d{2,}$/.test(t)

/** Stable key for matching. Never empty for a non-empty description. */
export function normalizeKey(raw: string): string {
  let s = raw.toUpperCase().replace(/(\S)#(\d)/g, '$1 #$2').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  for (const p of CHANNEL_PREFIXES) s = s.replace(p, '')
  s = s.replace(/^#\d+\s+(?=\S)/, '') // leading store number: "#288 SPORT CHEK"

  let tokens = s.split(' ').filter(Boolean)
  // bank reference numbers at the start or end ("... WENDY'S" is preceded by one; Visa Debit rows have it at the end)
  while (tokens.length > 1 && isRef(tokens[0]!)) tokens.shift()
  while (tokens.length > 1 && isRef(tokens[tokens.length - 1]!)) tokens.pop()
  // foreign-currency detail: "23.53 CAD @ 1.000000", "20.70 USD @ 1.428019"
  s = tokens.join(' ').replace(/\s+\d+(\.\d+)?\s+(CAD|USD|EUR|GBP)\s+@\s+[\d.]+$/, '').replace(/^(SQ|TST|PAYPAL)\s?\*\s?/, '') // and payment-processor prefixes (Square, Toast, PayPal)
  s = s.replace(/\s*\*\s*/g, '*') // "GOOGLE *YOUTUBE" and "GOOGLE*YOUTUBE" are the same merchant
  tokens = s.split(' ').filter(Boolean)

  const hadProvince = PROVINCE.test(s)
  if (hadProvince) tokens = s.replace(PROVINCE, '').split(' ').filter(Boolean)

  // cut at the first store/branch number (never at the very first token)
  let cut = -1
  for (let i = 1; i < tokens.length; i++) if (isStoreToken(tokens[i]!)) { cut = i; break }
  if (cut > 0) tokens = tokens.slice(0, cut)
  else if (hadProvince && tokens.length >= 2) tokens.pop() // trailing city: "MAZAJ LOUNGE MISSISSAUGA, ON"

  return tokens.join(' ').replace(/\s*\((REFUND|REVERSAL|CREDIT|CANCELLED|CANCELED)\)$/, '').replace(/[\s,.\-/]+$/, '').trim() || s
}

export function displayName(key: string): string {
  return key
    .split(' ')
    .map((w) => {
      const lower = w.toLowerCase()
      const mc = /^(mc)([a-z])(.*)$/.exec(lower)
      if (mc) return `Mc${mc[2]!.toUpperCase()}${mc[3]}`
      return lower.replace(/(^|[-'*/])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    })
    .join(' ')
}
