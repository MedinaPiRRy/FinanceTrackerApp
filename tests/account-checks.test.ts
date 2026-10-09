import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { checkBalance, matchBankBalance, findCrossDuplicates, deleteCrossDuplicates } from '../src/db/accountChecks'
import { listAccounts } from '../src/db/queries'

let db: Db
let p: number, chq: number, visaA: number, visaB: number
let n = 0
const add = (account: number, date: string, cents: number, text = 'X', kind = 'expense') =>
  Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, source, fingerprint) VALUES (?,?,?,?,?,?,?,'import',?)").run(p, account, date, cents, text, text, kind, `c${n++}`).lastInsertRowid)
const value = (id: number) => listAccounts(db, p).find((a) => a.id === id)!.valueCents

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('sam', 'Sam')").run().lastInsertRowid)
  const acct = (name: string, type: string, opening = 0) => Number(db.prepare('INSERT INTO account (profile_id, name, type, opening_balance_cents) VALUES (?,?,?,?)').run(p, name, type, opening).lastInsertRowid)
  chq = acct('Chequing', 'chequing', -25_896)
  visaA = acct('Cashback Visa', 'credit_card')
  visaB = acct('Aventura Visa', 'credit_card')
})

describe('matching the bank’s balance', () => {
  it('sets the starting balance so the account agrees with the bank, changing no transaction', () => {
    add(chq, '2026-01-02', -66_343)
    expect(value(chq)).toBe(-92_239)
    const c = checkBalance(db, p, chq, 37_038)
    expect(c).toMatchObject({ appCents: -92_239, bankCents: 37_038, openingCents: -25_896, newOpeningCents: 103_381, txnCount: 1, warnings: [] })
    expect(value(chq)).toBe(-92_239) // checking changes nothing
    matchBankBalance(db, p, chq, 37_038)
    expect(value(chq)).toBe(37_038)
    expect((db.prepare('SELECT COUNT(*) n FROM txn WHERE account_id = ?').get(chq) as { n: number }).n).toBe(1)
  })

  it('a card is typed as the amount owed, and an impossible starting credit is warned about', () => {
    add(visaA, '2026-01-05', -100_000)
    const ok = checkBalance(db, p, visaA, 341_763) // owes $3,417.63
    expect(ok).toMatchObject({ bankCents: -341_763, newOpeningCents: -241_763 })
    expect(ok.warnings).toEqual([])
    add(visaB, '2026-01-05', -344_552)
    const impossible = checkBalance(db, p, visaB, 0)
    expect(impossible.newOpeningCents).toBe(344_552)
    expect(impossible.warnings[0]).toMatch(/START with a credit/)
    expect(() => checkBalance(db, p, visaA, -5)).toThrow(/positive number/)
  })

  it('refuses investments and other people’s accounts', () => {
    const inv = Number(db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'FHSA', 'investment')").run(p).lastInsertRowid)
    expect(() => checkBalance(db, p, inv, 1000)).toThrow(/valued by hand/)
    expect(() => checkBalance(db, p + 1, chq, 1000)).toThrow(/no longer exists/)
  })
})

describe('the same transactions in two accounts', () => {
  const fill = (months: string[], dupes: boolean) => {
    for (const m of months) for (let i = 1; i <= 6; i++) {
      add(visaA, `${m}-${String(i + 2).padStart(2, '0')}`, -(1000 + i * 111), 'Shop (workbook)')
      if (dupes) add(visaB, `${m}-${String(i + 2).padStart(2, '0')}`, -(1000 + i * 111), 'SHOP LTD (statement)')
    }
  }

  it('finds two accounts that hold the same purchases for several months, and nothing for ordinary coincidences', () => {
    fill(['2026-01', '2026-02', '2026-03'], true)
    // earlier months: different purchases on the two cards that happen to share one amount
    for (let i = 1; i <= 6; i++) { add(visaA, `2025-06-0${i}`, -(500 + i)); add(visaB, `2025-06-0${i}`, -(900 + i)) }
    add(visaA, '2025-06-20', -777); add(visaB, '2025-06-20', -777)
    const found = findCrossDuplicates(db, p)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ months: ['2026-01', '2026-02', '2026-03'], matches: 18, rowsA: 18, rowsB: 18 })
    expect(found[0]!.examples[0]).toMatchObject({ date: '2026-01-03', descriptionA: 'Shop (workbook)', descriptionB: 'SHOP LTD (statement)' })
    expect(findCrossDuplicates(db, p).length).toBe(1)
  })

  it('finds nothing when the accounts are different, or the overlap is only a couple of coincidences', () => {
    fill(['2026-01', '2026-02'], false)
    add(visaB, '2026-01-03', -1111); add(visaB, '2026-02-04', -1222)
    expect(findCrossDuplicates(db, p)).toEqual([])
  })

  it('deleting the copies from one account leaves the other exactly as it was, and fixes both balances', () => {
    fill(['2026-01', '2026-02', '2026-03'], true)
    add(visaB, '2026-03-30', -5000, 'Only on B')
    const before = value(visaA)
    const r = deleteCrossDuplicates(db, p, visaB, visaA)
    expect(r).toEqual({ deleted: 18 })
    expect(value(visaA)).toBe(before)
    expect(value(visaB)).toBe(-5000)
    expect(() => deleteCrossDuplicates(db, p, visaB, visaA)).toThrow(/no longer share/)
    expect(() => deleteCrossDuplicates(db, p, visaB, visaB)).toThrow(/two different accounts/)
  })
})
