import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseStatement, validColumnMap } from '../src/core/statement'
import { createHandlers } from '../src/main/handlers'

// A layout the automatic detection cannot read: no recognisable header, five columns, dates as day/month/year.
const ODD = [
  ['Ref', 'When', 'Who', 'Out', 'In'],
  ['1', '25/09/2026', 'COFFEE SHOP', '4.50', ''],
  ['2', '26/09/2026', 'PAYROLL', '', '1,200.00'],
  ['3', '27/09/2026', 'BAD ROW', 'abc', '']
]

describe('user-mapped columns', () => {
  it('the automatic parser gives up on an unfamiliar layout', () => {
    expect(parseStatement(ODD).rows).toEqual([])
  })

  it('reads debit and credit columns the user pointed at, and skips bad rows with a reason', () => {
    const r = parseStatement(ODD, { columns: { headerRow: true, date: 1, description: 2, debit: 3, credit: 4 } })
    expect(r.rows.map((x) => [x.date, x.description, x.amountCents])).toEqual([['2026-09-25', 'COFFEE SHOP', -450], ['2026-09-26', 'PAYROLL', 120000]])
    expect(r.warnings.join(' ')).toMatch(/Line 4: skipped \(unreadable amount\)/)
  })

  it('reads a single signed amount column, and can flip the sign', () => {
    const rows = [['2026-03-01', 'RENT', '-1000.00'], ['2026-03-02', 'REFUND', '25.00']]
    const a = parseStatement(rows, { columns: { headerRow: false, date: 0, description: 1, amount: 2 } })
    expect(a.rows.map((x) => x.amountCents)).toEqual([-100000, 2500])
    const b = parseStatement(rows, { columns: { headerRow: false, date: 0, description: 1, amount: 2 }, flipSign: true })
    expect(b.rows.map((x) => x.amountCents)).toEqual([100000, -2500])
  })

  it('refuses an invalid column choice instead of guessing', () => {
    expect(validColumnMap({ headerRow: true, date: 0, description: 1 })).toBe(false) // no amount column
    expect(validColumnMap({ headerRow: true, date: -1, description: 1, amount: 2 })).toBe(false)
    expect(validColumnMap({ headerRow: true, date: 0, description: 1, amount: 2.5 })).toBe(false)
    expect(parseStatement(ODD, { columns: { headerRow: true, date: 1, description: 2 } as never }).warnings[0]).toMatch(/not valid/)
  })
})

describe('import handlers remember the column choice per account', () => {
  const csv = ODD.slice(0, 3).map((r) => r.join(',').replace('1,200.00', '"1,200.00"')).join('\n')
  const b64 = Buffer.from(csv).toString('base64')

  it('peeks at the file, fails clearly the first time, then works with a mapping and without one afterwards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cols-'))
    const h = createHandlers(path.join(dir, 'finance.db'))
    const [pid] = h.setupOwn('single', [{ name: 'Test', accounts: [{ name: 'Chequing', type: 'chequing' }] }])
    const acc = h.accounts(pid!).find((a) => a.name === 'Chequing')!.id

    expect(h.importPeek('x.csv', b64).rows[0]).toEqual(['Ref', 'When', 'Who', 'Out', 'In'])
    expect(() => h.importPreview(pid!, acc, 'x.csv', b64)).toThrow()
    const pv = h.importPreview(pid!, acc, 'x.csv', b64, { columns: { headerRow: true, date: 1, description: 2, debit: 3, credit: 4 } })
    expect(pv.rows).toHaveLength(2)
    // remembered: the same layout now previews with no options at all
    expect(h.importPreview(pid!, acc, 'again.csv', b64).rows).toHaveLength(2)
    // ...but only for that account
    const other = h.accountCreate(pid!, { name: 'Other', type: 'chequing' })
    expect(() => h.importPreview(pid!, other, 'again.csv', b64)).toThrow()
    h.close()
  })
})
