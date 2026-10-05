import { describe, it, expect } from 'vitest'
import { parseStatement, parseDate, detectDateOrder } from '../src/core/statement'
import { normalizeKey, displayName } from '../src/core/normalize'
import { classifyRow, builtinTag } from '../src/core/classify'
import { keyMatches, matchRule, buildHistoryRules, categoryForTag, type Rule } from '../src/core/categorize'

describe('statement parsing', () => {
  it('reads a headerless CIBC credit-card export (charge, payment) with card-style signs', () => {
    const p = parseStatement([
      ['2026-09-25', "MCDONALD'S #40732 MILTON, ON", '8.92', '', '4000********4879'],
      ['2026-09-14', 'PAYMENT THANK YOU/PAIEMEN T MERCI', '', '300.00', '4000********4879']
    ])
    expect(p.format).toBe('cibc-card')
    expect(p.rows.map((r) => r.amountCents)).toEqual([-892, 30000]) // charge negative, payment positive
  })
  it('reads a headerless CIBC chequing export (out, in)', () => {
    const p = parseStatement([
      ['2026-09-21', 'Electronic Funds Transfer PREAUTHORIZED DEBIT 900000005 Fit4less by GoodLife', '15.81', ''],
      ['2026-09-18', 'Electronic Funds Transfer PAY 90000000006 258 ACME FABRICS INC.', '', '1483.44']
    ])
    expect(p.format).toBe('cibc-chequing')
    expect(p.rows.map((r) => r.amountCents)).toEqual([-1581, 148344])
  })
  it('skips unreadable rows with a warning instead of failing the whole file', () => {
    const p = parseStatement([['2026-09-25', 'OK', '1.00', ''], ['2026-13-45', 'Bad date', '1.00', ''], ['2026-09-26', 'Bad amount', 'abc', ''], ['2026-09-27', 'Zero', '0', '']])
    expect(p.rows).toHaveLength(1)
    expect(p.warnings).toHaveLength(3)
  })
  it('reads files with a header row: separate debit/credit columns', () => {
    const p = parseStatement([['Transaction Date', 'Description', 'Debit', 'Credit', 'Balance'], ['2026-03-01', 'Coffee', '4.50', '', '100'], ['2026-03-02', 'Paycheque', '', '1,200.00', '1300']])
    expect(p.format).toBe('headered')
    expect(p.rows.map((r) => r.amountCents)).toEqual([-450, 120000])
  })
  it('single Amount column: sign kept, or flipped for banks that list spending as positive', () => {
    const rows = [['Date', 'Description', 'Amount'], ['2026-03-01', 'Coffee', '-4.50'], ['2026-03-02', 'Refund', '10.00']]
    expect(parseStatement(rows).rows.map((r) => r.amountCents)).toEqual([-450, 1000])
    expect(parseStatement(rows, { flipSign: true }).rows.map((r) => r.amountCents)).toEqual([450, -1000])
  })
  it('detects day/month order from the whole column and warns when ambiguous', () => {
    expect(detectDateOrder(['25/03/2026', '01/04/2026'])).toEqual({ order: 'dmy', ambiguous: false })
    expect(detectDateOrder(['03/25/2026', '04/01/2026'])).toEqual({ order: 'mdy', ambiguous: false })
    expect(detectDateOrder(['03/04/2026'])).toEqual({ order: 'mdy', ambiguous: true })
    expect(parseDate('25/03/2026', 'dmy')).toBe('2026-03-25')
    expect(parseDate('2026-02-30')).toBeNull()
    const w = parseStatement([['Date', 'Description', 'Amount'], ['03/04/2026', 'x', '-1']]).warnings
    expect(w.join(' ')).toMatch(/could be March 4 or April 3/)
  })
  it('says so when it cannot find the columns', () => {
    expect(parseStatement([['foo', 'bar'], ['1', '2']]).format).toBe('unknown')
    expect(parseStatement([]).warnings[0]).toMatch(/empty/)
  })
})

describe('merchant keys', () => {
  const k = normalizeKey
  it('removes store numbers, cities and provinces', () => {
    expect(k("MCDONALD'S #40732 MILTON, ON")).toBe("MCDONALD'S")
    expect(k("MCDONALD'S #8446 Q04 OAKVILLE, ON")).toBe("MCDONALD'S")
    expect(k('SHOPPERS DRUG MART 710 MILTON, ON')).toBe('SHOPPERS DRUG MART')
    expect(k('PETRO-CANADA 35288 MILTON, ON')).toBe('PETRO-CANADA')
    expect(k('MAZAJ LOUNGE MISSISSAUGA, ON')).toBe('MAZAJ LOUNGE')
    expect(k('SHELL C02420 OAKVILLE, ON')).toBe('SHELL')
    expect(k('Spotify P463D6C213 Stockholm')).toBe('SPOTIFY')
    expect(k('WAL-MART SUPERCENTER#1000 MILTON, ON')).toBe('WAL-MART SUPERCENTER')
  })
  it('strips bank channel wording and reference numbers on chequing lines', () => {
    expect(k("Point of Sale - Interac RETAIL PURCHASE 900000000007 WENDY'S")).toBe("WENDY'S")
    expect(k('Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE SAMPLE CASINO 900000000008')).toBe('SAMPLE CASINO')
    expect(k('Point of Sale - Interac RETAIL PURCHASE 900000000009 SQ *SAMPLE ACUPUN')).toBe('SAMPLE ACUPUN')
    expect(k('Electronic Funds Transfer PREAUTHORIZED DEBIT 900000005 Fit4less by GoodLife')).toBe('FIT4LESS BY GOODLIFE')
    expect(k('Electronic Funds Transfer PAY 90000000006 258 ACME FABRICS INC.')).toBe('ACME FABRICS INC')
    expect(k('Internet Banking E-TRANSFER 900000000003 Pat Kim')).toBe('PAT KIM')
    expect(k('Point of Sale - Interac RETAIL PURCHASE 900000000010 CINEPLEX #7123')).toBe('CINEPLEX')
  })
  it('strips foreign-currency detail and never returns an empty key', () => {
    expect(k('UNLOCKT.ME 302-6587581, WA 20.70 USD @ 1.428019')).toContain('UNLOCKT.ME')
    expect(k('7ELEVEN')).toBe('7ELEVEN')
    expect(k("McDonald's (refund)")).toBe("MCDONALD'S")
    expect(k('   ')).toBe('')
  })
  it('makes readable display names', () => {
    expect(displayName("MCDONALD'S")).toBe("McDonald's")
    expect(displayName('TIM HORTONS')).toBe('Tim Hortons')
    expect(displayName('PETRO-CANADA')).toBe('Petro-Canada')
  })
})

describe('classification', () => {
  it('always sends e-transfers to review, in both directions', () => {
    const a = classifyRow('chequing', 'Internet Banking E-TRANSFER 900000000003 Pat Kim', -3000)
    const b = classifyRow('chequing', 'Internet Banking E-TRANSFER 900000000011 Someone', 5000)
    expect(a).toMatchObject({ kind: 'unclassified' }); expect(a.reviewReason).toMatch(/sent/)
    expect(b).toMatchObject({ kind: 'unclassified' }); expect(b.reviewReason).toMatch(/received/)
  })
  it('treats card payments and own-account moves as transfers, never spending', () => {
    expect(classifyRow('credit_card', 'PAYMENT THANK YOU/PAIEMEN T MERCI', 30000).kind).toBe('transfer')
    expect(classifyRow('chequing', 'Internet Banking INTERNET TRANSFER 900000000004 TO CARD 4111********2746', -147854).kind).toBe('transfer')
    expect(classifyRow('chequing', 'Internet Banking INTERNET TRANSFER 900000000012 FROM ACCOUNT 07432/****437', 5000).kind).toBe('transfer')
  })
  it('flags ambiguous money movements for review', () => {
    expect(classifyRow('chequing', 'Branch Transaction MEMO - INVESTMENT IBB DERRY & THOMPSON BANKING CENTR', -800000).reviewReason).toMatch(/investment/i)
    expect(classifyRow('chequing', 'Automated Banking Machine ATM DEPOSIT ALEX SAMPLE BKNG CTR 3D1C', 5000).reviewReason).toMatch(/tips/)
    expect(classifyRow('chequing', 'Internet Banking INTERNET TRANSFER 900000000013', -120000).reviewReason).toMatch(/no destination/)
    expect(classifyRow('chequing', 'Internet Banking INTERNET DEPOSIT 900000000014', 7218).kind).toBe('unclassified')
  })
  it('recognises payroll as income, fees as expenses and fee rebates as refunds', () => {
    expect(classifyRow('chequing', 'Electronic Funds Transfer PAY 90000000006 258 ACME FABRICS INC.', 148344)).toMatchObject({ kind: 'income', needsCategory: true })
    expect(classifyRow('chequing', 'Branch Transaction SERVICE CHARGE CAPPED MONTHLY FEE$16.95 RECORD-KEEPING N/A', -1695)).toMatchObject({ kind: 'expense', tag: 'fees' })
    expect(classifyRow('chequing', 'Branch Transaction SERVICE CHARGE DISCOUNT', 1695)).toMatchObject({ kind: 'refund', tag: 'fees' })
    expect(classifyRow('credit_card', 'PURCHASE INTEREST', -4629)).toMatchObject({ kind: 'expense', tag: 'fees' })
    expect(classifyRow('credit_card', 'INTEREST REVERSAL', 36)).toMatchObject({ kind: 'refund' })
  })
  it('treats an ordinary purchase as an expense and a card credit as a refund', () => {
    expect(classifyRow('credit_card', "MCDONALD'S #40732 MILTON, ON", -892)).toMatchObject({ kind: 'expense', needsCategory: true })
    expect(classifyRow('credit_card', "MCDONALD'S #8446 Q04 OAKVILLE, ON", 857)).toMatchObject({ kind: 'refund' })
    expect(classifyRow('chequing', "Point of Sale - Interac RETAIL PURCHASE 900000000007 WENDY'S", -631)).toMatchObject({ kind: 'expense' })
  })
  it('has built-in keyword tags', () => {
    expect(builtinTag("MCDONALD'S")).toBe('dining')
    expect(builtinTag('PETRO-CANADA')).toBe('transport')
    expect(builtinTag('SPOTIFY')).toBe('subscriptions')
    expect(builtinTag('QWERTY CORP')).toBeNull()
  })
})

describe('rules', () => {
  const rule = (pattern: string, categoryId: number, priority: number, source: Rule['source'] = 'history'): Rule => ({ pattern, merchant: pattern, categoryId, priority, source })
  it('matches whole-word prefixes and bank-truncated names, but not random substrings', () => {
    expect(keyMatches('TIM HORTONS', 'TIM HORTONS')).toBe(true)
    expect(keyMatches('TIM HORTONS DRIVE THRU', 'TIM HORTONS')).toBe(true)
    expect(keyMatches('SHOPPERS DRUG M', 'SHOPPERS DRUG MART')).toBe(true) // bank cut the name
    expect(keyMatches('SHELLFISH BAR', 'SHELL')).toBe(false)
    expect(keyMatches('TIM', 'TIM HORTONS')).toBe(false)
    expect(keyMatches("MCDONALD'S EXPRESS", "MCDONALD'S")).toBe(true) // whole-word prefix
    expect(keyMatches("MCDONALD'S", "MCDONALD'S EXPRESS")).toBe(false) // a rule for a longer name does not match a shorter key
    expect(keyMatches('BEST BUY', 'BEST BUYING CLUB')).toBe(false) // a short name is not a truncation of a longer one
  })
  it('prefers your corrections over aliases over history, then the longest pattern', () => {
    const rules = [rule('CIRCLE K', 1, 60), rule('CIRCLE K', 2, 10, 'user'), rule('CIRCLE K', 3, 20, 'alias'), rule('CIRCLE K ESSO', 4, 60)]
    expect(matchRule('CIRCLE K', rules)?.categoryId).toBe(2)
    expect(matchRule('CIRCLE K ESSO MILTON', [rule('CIRCLE K', 1, 60), rule('CIRCLE K ESSO', 4, 60)])?.categoryId).toBe(4)
    expect(matchRule('UNKNOWN PLACE', rules)).toBeNull()
  })
  it('learns the majority category from history only when it is clear', () => {
    const rules = buildHistoryRules([
      { key: 'A', description: 'Alpha', categoryId: 1 }, { key: 'A', description: 'Alpha', categoryId: 1 }, { key: 'A', description: 'Alpha Store', categoryId: 2 },
      { key: 'B', description: 'Bravo', categoryId: 1 }, { key: 'B', description: 'Bravo', categoryId: 2 },
      { key: 'C', description: 'Charlie', categoryId: null }
    ])
    expect(rules.map((r) => r.pattern)).toEqual(['A']) // B is 50/50, C has no category
    expect(rules[0]).toMatchObject({ categoryId: 1, merchant: 'Alpha' })
  })
  it("maps built-in tags onto the person's own category names", () => {
    const cats = [{ id: 1, name: 'Fast Food & Dining', kind: 'expense' }, { id: 2, name: 'Gas & Transportation', kind: 'expense' }, { id: 3, name: 'Salary', kind: 'income' }]
    expect(categoryForTag('dining', cats)).toBe(1)
    expect(categoryForTag('transport', cats)).toBe(2)
    expect(categoryForTag('groceries', cats)).toBeNull()
  })
})
