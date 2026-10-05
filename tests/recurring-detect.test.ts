import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { detectRecurring, findStopped, sameMerchant, type DetectTxn } from '../src/core/recurringDetect'
import { suggestRecurring, addDetected, dismissSuggestion, stoppedItems, answerStopped } from '../src/db/recurringDetect'
import { generateSample } from '../src/demo/sample'

const series = (key: string, dates: string[], cents: number | number[], direction: 'income' | 'expense' = 'expense', accountId = 1): DetectTxn[] =>
  dates.map((date, i) => ({ key, date, amountCents: direction === 'expense' ? -(Array.isArray(cents) ? cents[i]! : cents) : (Array.isArray(cents) ? cents[i]! : cents), direction, accountId }))
const monthly = (key: string, day: number, months: string[], cents: number | number[], direction: 'income' | 'expense' = 'expense') =>
  series(key, months.map((m) => `${m}-${String(day).padStart(2, '0')}`), cents, direction)
const M = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
const TODAY = '2026-10-04'

describe('detectRecurring', () => {
  it('finds a monthly subscription and reports the latest amount, count and next date', () => {
    const [d] = detectRecurring(monthly('NETFLIX.COM', 9, M, [1499, 1499, 1499, 1649, 1649]), TODAY)
    expect(d).toMatchObject({ key: 'NETFLIX.COM', name: 'Netflix.com', frequency: 'monthly', amountCents: 1649, occurrences: 5, lastDate: '2026-09-09', nextExpected: '2026-10-09' })
  })

  it('tolerates dates that slip around weekends and month ends', () => {
    const dates = ['2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']
    expect(detectRecurring(series('RENT', dates, 140000), TODAY)[0]!.frequency).toBe('monthly')
  })

  it('finds weekly, every-two-weeks (pay) and quarterly patterns', () => {
    const weekly = series('YOGA STUDIO', ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'], 2500)
    const pay = series('ACME PAYROLL', ['2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18', '2026-10-02'], 215000, 'income')
    const quarterly = series('INSURER', ['2026-01-05', '2026-04-05', '2026-07-05'], 18000)
    const out = detectRecurring([...weekly, ...pay, ...quarterly], TODAY)
    expect(out.map((d) => [d.key, d.frequency, d.direction])).toEqual([
      ['ACME PAYROLL', 'biweekly', 'income'], ['INSURER', 'quarterly', 'expense'], ['YOGA STUDIO', 'weekly', 'expense']
    ])
  })

  it('does not treat shopping with a changing amount as recurring', () => {
    const groceries = monthly('LOBLAWS', 3, M, [5800, 14200, 9100, 12700, 7300])
    const weeklyShop = series('NO FRILLS', ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'], [3100, 9800, 5400, 12000])
    expect(detectRecurring([...groceries, ...weeklyShop], TODAY)).toEqual([])
  })

  it('needs at least three occurrences and a steady rhythm', () => {
    expect(detectRecurring(monthly('GYM', 5, ['2026-08', '2026-09'], 4000), TODAY)).toEqual([])
    expect(detectRecurring(series('RANDOM', ['2026-05-01', '2026-06-20', '2026-07-03', '2026-09-28'], 2000), TODAY)).toEqual([])
  })

  it('ignores a payment that ended long ago, and counts two charges on one day as one', () => {
    expect(detectRecurring(monthly('OLD GYM', 5, ['2025-01', '2025-02', '2025-03', '2025-04'], 4000), TODAY)).toEqual([])
    const doubled = [...monthly('PHONE', 7, M.slice(2), 6500), ...monthly('PHONE', 7, M.slice(2), 6500)]
    expect(detectRecurring(doubled, TODAY)[0]!.occurrences).toBe(3)
  })

  it('keeps income and expense with the same name apart, and allows more wobble in pay than in a bill', () => {
    const pay = monthly('EMPLOYER', 15, M, [200000, 230000, 190000, 220000, 205000], 'income')
    const bill = monthly('EMPLOYER', 15, M, [20000, 30000, 15000, 26000, 20500])
    const out = detectRecurring([...pay, ...bill], TODAY)
    expect(out).toHaveLength(1)
    expect(out[0]!.direction).toBe('income')
  })

  it('rates a long, perfectly steady series as high confidence and a short wobbly one as medium', () => {
    expect(detectRecurring(monthly('SPOTIFY', 12, M, 1199), TODAY)[0]!.confidence).toBe('high')
    expect(detectRecurring(monthly('SPOTIFY', 12, M.slice(2), 1199), TODAY)[0]!.confidence).toBe('medium')
  })
})

describe('sameMerchant', () => {
  it('matches name variants, not different merchants', () => {
    expect(sameMerchant('NETFLIX.COM', 'NETFLIX')).toBe(true)
    expect(sameMerchant('GOODLIFE FITNESS MEMBERSHIP', 'GOODLIFE FITNESS')).toBe(true)
    expect(sameMerchant('NETFLIX', 'SPOTIFY')).toBe(false)
    expect(sameMerchant('', 'X')).toBe(false)
  })
})

describe('findStopped', () => {
  const item = (over: object) => ({ id: 1, name: 'Gym', frequency: 'monthly', lastSeen: '2026-07-15', checkedAt: null, coverageEnd: '2026-09-30', ...over })
  it('flags a monthly bill once the data has gone past its due date plus a grace period', () => {
    expect(findStopped([item({})])).toEqual([{ id: 1, name: 'Gym', lastSeen: '2026-07-15', expectedBy: '2026-08-14', missed: 2 }])
    expect(findStopped([item({ coverageEnd: '2026-08-20' })])).toEqual([]) // within grace of the due date
    expect(findStopped([item({ lastSeen: '2026-09-15' })])).toEqual([])
  })
  it('never asks when the data does not reach the due date (statement not imported yet)', () => {
    expect(findStopped([item({ lastSeen: '2026-07-15', coverageEnd: '2026-07-31' })])).toEqual([])
    expect(findStopped([item({ coverageEnd: null })])).toEqual([])
  })
  it('"still active" counts as having seen it, so the question waits a full cycle', () => {
    expect(findStopped([item({ checkedAt: '2026-09-30' })])).toEqual([])
    expect(findStopped([item({ checkedAt: '2026-09-01', coverageEnd: '2026-11-15' })]).map((s) => s.id)).toEqual([1])
  })
  it('weekly items need two missed weeks before a question; irregular ones are never asked about', () => {
    expect(findStopped([item({ frequency: 'weekly', lastSeen: '2026-09-10', coverageEnd: '2026-09-20' })])).toEqual([])
    expect(findStopped([item({ frequency: 'weekly', lastSeen: '2026-09-01', coverageEnd: '2026-09-30' })])).toHaveLength(1)
    expect(findStopped([item({ frequency: 'irregular' })])).toEqual([])
  })
})

describe('database layer', () => {
  let db: Db
  let p: number, chq: number, card: number
  let n = 0
  const add = (account: number, date: string, cents: number, text: string, kind = 'expense') =>
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, source, fingerprint) VALUES (?,?,?,?,?,?,?,'import',?)").run(p, account, date, cents, text, text, kind, `r${n++}`)
  beforeEach(() => {
    db = openDb(':memory:')
    ;[p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Card', type: 'credit_card' }] }]) as [number]
    chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
    card = (db.prepare("SELECT id FROM account WHERE name = 'Card'").get() as { id: number }).id
  })

  it('suggests untracked payments, adds them with facts taken from the data, and does not suggest them again', () => {
    for (const m of M) { add(card, `${m}-09`, -1649, 'NETFLIX.COM'); add(chq, `${m}-15`, 200000, 'PAYROLL ACME', 'income') }
    const s = suggestRecurring(db, p, TODAY)
    expect(s.map((x) => [x.name, x.direction, x.monthlyCents])).toEqual([['Payroll Acme', 'income', 200000], ['Netflix.com', 'expense', 1649]])
    expect(s[1]).toMatchObject({ accountName: 'Card', frequency: 'monthly' })
    const ids = addDetected(db, p, [{ key: 'NETFLIX.COM', direction: 'expense', name: 'Netflix' }], TODAY)
    expect(db.prepare('SELECT name, amount_cents a, frequency f, status s, account_id acc, source src, last_charged lc, counts_in_budget c FROM recurring WHERE id = ?').get(ids[0])).toEqual({ name: 'Netflix', a: 1649, f: 'monthly', s: 'active', acc: card, src: 'detected', lc: '2026-09-09', c: 1 })
    expect(suggestRecurring(db, p, TODAY).map((x) => x.key)).toEqual(['PAYROLL ACME'])
    expect(() => addDetected(db, p, [{ key: 'NETFLIX.COM', direction: 'expense' }], TODAY)).toThrow(/no longer a suggestion/)
  })

  it('an item tracked by hand under a different spelling is not suggested again, and tracked cancelled items are not either', () => {
    for (const m of M) { add(card, `${m}-09`, -1649, 'NETFLIX.COM'); add(card, `${m}-12`, -1199, 'SPOTIFY') }
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency) VALUES (?, 'Netflix', 'expense', ?, 1649, 'monthly')").run(p, card)
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, status) VALUES (?, 'Spotify', 'expense', ?, 1199, 'monthly', 'cancelled')").run(p, card)
    expect(suggestRecurring(db, p, TODAY)).toEqual([])
  })

  it('an item tracked under a completely different name is recognised by account, schedule and amount', () => {
    for (const m of M) add(card, `${m}-07`, -6599, 'ROGERS WIRELESS')
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency) VALUES (?, 'Phone plan', 'expense', ?, 6599, 'monthly')").run(p, card)
    expect(suggestRecurring(db, p, TODAY)).toEqual([])
    db.prepare("UPDATE recurring SET amount_cents = 9000").run() // a different amount is a different thing
    expect(suggestRecurring(db, p, TODAY)).toHaveLength(1)
  })

  it('"not recurring" is remembered', () => {
    for (const m of M) add(chq, `${m}-05`, -4000, 'GOODLIFE FITNESS')
    expect(suggestRecurring(db, p, TODAY)).toHaveLength(1)
    dismissSuggestion(db, p, 'GOODLIFE FITNESS', 'expense')
    expect(suggestRecurring(db, p, TODAY)).toEqual([])
  })

  it('ignores cash, transfers and rows still waiting in the review queue', () => {
    const cash = (db.prepare("SELECT id FROM account WHERE type = 'cash'").get() as { id: number }).id
    for (const m of M) { add(cash, `${m}-01`, -500, 'CORNER STORE'); add(chq, `${m}-02`, -30000, 'TRANSFER TO SAVINGS', 'transfer') }
    for (const m of M) db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, review_reason, source, fingerprint) VALUES (?,?,?,?,'E-TRANSFER TO X','unclassified','?','import',?)").run(p, chq, `${m}-03`, -2000, `q${n++}`)
    expect(suggestRecurring(db, p, TODAY)).toEqual([])
  })

  it('asks about a stopped bill, and the answer either cancels it or silences the question', () => {
    for (const m of ['2026-05', '2026-06', '2026-07']) add(card, `${m}-11`, -1399, 'DISNEY PLUS')
    for (const m of M) add(card, `${m}-20`, -5000, 'SOMETHING ELSE') // the account's data reaches September
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged) VALUES (?, 'Disney+', 'expense', ?, 1399, 'monthly', '2026-07-11')").run(p, card)
    const [q] = stoppedItems(db, p)
    expect(q).toMatchObject({ name: 'Disney+', lastSeen: '2026-07-11', expectedBy: '2026-08-10', amountCents: 1399, accountName: 'Card' })
    answerStopped(db, p, q!.id, 'active', '2026-10-04')
    expect(stoppedItems(db, p)).toEqual([])
    answerStopped(db, p, q!.id, 'cancelled', '2026-10-04')
    expect(db.prepare('SELECT status, notes FROM recurring WHERE id = ?').get(q!.id)).toMatchObject({ status: 'cancelled', notes: expect.stringContaining('Marked cancelled on 2026-10-04') })
    expect(() => answerStopped(db, p, 9999, 'active', TODAY)).toThrow(/no longer exists/)
  })

  it('finds the payments of an item named after what it is for, using the payee in brackets or after "e-transfer to"', () => {
    for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) add(chq, `${m}-20`, -6000, 'Internet Banking E-TRANSFER 000000123456 Jin Yu')
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged) VALUES (?, 'Lessons (Jin Yu)', 'expense', ?, 6000, 'monthly', '2026-05-20')").run(p, chq)
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged) VALUES (?, 'Phone (e-transfer to Jin Yu)', 'expense', ?, 6000, 'monthly', '2026-05-20')").run(p, chq)
    expect(stoppedItems(db, p)).toEqual([]) // September's payment to Jin Yu proves both are still going
    expect(suggestRecurring(db, p, TODAY)).toEqual([]) // and the payee is already tracked, so it is not suggested again
  })

  it('does not ask while the account has no data past the due date, nor about cash bills', () => {
    add(card, '2026-07-11', -1399, 'DISNEY PLUS')
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged) VALUES (?, 'Disney+', 'expense', ?, 1399, 'monthly', '2026-07-11')").run(p, card)
    expect(stoppedItems(db, p)).toEqual([])
    const cash = (db.prepare("SELECT id FROM account WHERE type = 'cash'").get() as { id: number }).id
    add(chq, '2026-09-28', -100, 'x')
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged) VALUES (?, 'Phone (cash)', 'expense', ?, 5000, 'monthly', '2026-03-01')").run(p, cash)
    expect(stoppedItems(db, p).map((s) => s.name)).not.toContain('Phone (cash)')
  })

  it('never reads another profile\'s transactions', () => {
    const other = createSetup(openDb(':memory:'), 'single', [{ name: 'Z', accounts: [] }])
    expect(other).toHaveLength(1)
    for (const m of M) add(card, `${m}-09`, -1649, 'NETFLIX.COM')
    const second = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('other', 'Other')").run().lastInsertRowid)
    expect(suggestRecurring(db, second, TODAY)).toEqual([])
  })
})

describe('sample data shows the feature', () => {
  it('finds rent, utilities and pay that are not tracked yet, and asks about the Disney+ subscription that stopped', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', new Date(2026, 9, 25))
    const profile = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const names = suggestRecurring(db, profile, '2026-10-25').map((s) => s.name)
    expect(names.some((x) => /payroll/i.test(x))).toBe(true)
    expect(names.some((x) => /rent/i.test(x))).toBe(true)
    expect(names.some((x) => /netflix/i.test(x))).toBe(false) // already tracked
    expect(stoppedItems(db, profile).map((s) => s.name)).toEqual(['Disney+'])
  })
})
