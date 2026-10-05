import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandlers } from '../src/main/handlers'
import { layoutOf } from '../src/core/statement'

const b64 = (s: string) => Buffer.from(s).toString('base64')

// Two layouts: a headered chequing export, and a headerless five-column card export (date, description, charge, payment, card number).
const CHEQUING = 'Date,Description,Debit,Credit\n2026-09-01,TIM HORTONS #1234,4.50,\n2026-09-02,PAYROLL ACME,,1500.00\n2026-09-03,LOBLAWS 0042,86.10,\n'
const CARD = '2026-09-01,"NETFLIX.COM",16.49,,4500********1234\n2026-09-05,"SHELL C123",52.00,,4500********1234\n'

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-match-'))
  const h = createHandlers(path.join(dir, 'finance.db'))
  const [pid] = h.setupOwn('single', [{ name: 'Test', accounts: [{ name: 'Everyday Chequing', type: 'chequing' }, { name: 'Savings', type: 'savings' }, { name: 'Rewards Visa', type: 'credit_card' }, { name: 'Travel Mastercard', type: 'credit_card' }] }]) as [number]
  const acc = (name: string) => h.accounts(pid).find((a) => a.name === name)!.id
  const importFile = (account: number, name: string, text: string) => {
    const pv = h.importPreview(pid, account, name, b64(text))
    const rows = pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
    return { pv, res: h.importCommit(pid, account, name, rows, true, { fileHash: pv.fileHash, layout: pv.layout }) }
  }
  return { h, pid, acc, importFile }
}

describe('layoutOf', () => {
  it('uses the header cells when there is a header and the column count when there is not', () => {
    expect(layoutOf([['Date', ' Description ', 'Debit', 'Credit'], ['2026-09-01', 'x', '1', '']])).toBe('h:date|description|debit|credit')
    expect(layoutOf([['2026-09-01', 'x', '1', '', '4500***1234']])).toBe('cols:5')
    expect(layoutOf([['Account activity for September'], ['Date', 'Details', 'Amount']])).toBe('h:date|details|amount')
    expect(layoutOf([])).toBe('empty')
  })
})

describe('re-importing never double-records', () => {
  it('importing the same file twice adds nothing the second time, even under another name', () => {
    const { h, pid, acc, importFile } = setup()
    const chq = acc('Everyday Chequing')
    expect(importFile(chq, 'sept.csv', CHEQUING).res.inserted).toBe(3)
    const again = importFile(chq, 'renamed copy (1).csv', CHEQUING)
    expect(again.pv.rows.every((r) => r.status === 'duplicate')).toBe(true)
    expect(again.res.inserted).toBe(0)
    expect(h.txns(pid, {}).total).toBe(3)
    h.close()
  })

  it('an overlapping export only adds the new rows', () => {
    const { h, pid, acc, importFile } = setup()
    const chq = acc('Everyday Chequing')
    importFile(chq, 'a.csv', CHEQUING)
    const more = CHEQUING + '2026-09-04,SHOPPERS DRUG MART,12.00,\n'
    expect(importFile(chq, 'b.csv', more).res.inserted).toBe(1)
    expect(h.txns(pid, {}).total).toBe(4)
    h.close()
  })

  it('the same file is recognised and flagged, and sending it to a different account needs an explicit confirmation', () => {
    const { h, pid, acc, importFile } = setup()
    const chq = acc('Everyday Chequing'), sav = acc('Savings')
    importFile(chq, 'sept.csv', CHEQUING)
    const pv = h.importPreview(pid, sav, 'sept.csv', b64(CHEQUING))
    expect(pv.sameFileBefore).toMatchObject({ accountId: chq, accountName: 'Everyday Chequing', rowCount: 3 })
    expect(pv.rows.every((r) => r.status === 'new')).toBe(true) // nothing in Savings yet, so only the file-level guard can stop this
    const rows = pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
    expect(() => h.importCommit(pid, sav, 'sept.csv', rows, true, { fileHash: pv.fileHash, layout: pv.layout })).toThrow(/already imported into "Everyday Chequing"/)
    expect(h.txns(pid, {}).total).toBe(3)
    expect(h.importCommit(pid, sav, 'sept.csv', rows, true, { fileHash: pv.fileHash, layout: pv.layout, allowOtherAccount: true }).inserted).toBe(3)
    h.close()
  })

  it('after undoing an import the file can be imported again', () => {
    const { h, pid, acc, importFile } = setup()
    const chq = acc('Everyday Chequing')
    const first = importFile(chq, 'a.csv', CHEQUING)
    h.importUndo(pid, first.res.batchId)
    expect(h.importPreview(pid, chq, 'a.csv', b64(CHEQUING)).sameFileBefore).toBeNull()
    expect(importFile(chq, 'a.csv', CHEQUING).res.inserted).toBe(3)
    h.close()
  })
})

describe('account suggestions for the import page', () => {
  const file = (name: string, text: string) => ({ name, base64: b64(text) })

  it('with no file it offers the account used last, and nothing before any import', () => {
    const { h, pid, acc, importFile } = setup()
    expect(h.importSuggest(pid)).toBeNull()
    importFile(acc('Savings'), 'x.csv', CHEQUING)
    expect(h.importSuggest(pid)).toMatchObject({ accountId: acc('Savings'), reason: 'last_used' })
    h.close()
  })

  it('matches by file name when exactly one account fits', () => {
    const { h, pid, acc } = setup()
    expect(h.importSuggest(pid, file('everyday-chequing-2026-09.csv', CHEQUING))).toMatchObject({ accountId: acc('Everyday Chequing'), reason: 'file_name' })
    expect(h.importSuggest(pid, file('savings_statement.csv', CHEQUING))).toMatchObject({ accountId: acc('Savings'), reason: 'file_name' })
    expect(h.importSuggest(pid, file('Travel Mastercard Sept.csv', CHEQUING))).toMatchObject({ accountId: acc('Travel Mastercard'), reason: 'file_name' })
    h.close()
  })

  it('does not guess when a name fits several accounts or none', () => {
    const { h, pid } = setup()
    expect(h.importSuggest(pid, file('credit_card_export.csv', CHEQUING))).toBeNull() // two credit cards fit equally well
    expect(h.importSuggest(pid, file('transactions (3).csv', CHEQUING))).toBeNull()
    expect(h.importSuggest(pid, file('download.csv', CHEQUING))).toBeNull()
    h.close()
  })

  it('learns the column layout: the next file shaped like an earlier import goes to the same account', () => {
    const { h, pid, acc, importFile } = setup()
    importFile(acc('Travel Mastercard'), 'a.csv', CARD)
    expect(h.importSuggest(pid, file('whatever.csv', CARD.replace('NETFLIX.COM', 'SPOTIFY')))).toMatchObject({ accountId: acc('Travel Mastercard'), reason: 'layout' })
    // a different layout is not matched by that memory
    expect(h.importSuggest(pid, file('whatever.csv', CHEQUING))?.reason).not.toBe('layout')
    h.close()
  })

  it('a five-column card export goes to the only credit card, and is left alone when there are two', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-match-'))
    const h = createHandlers(path.join(dir, 'finance.db'))
    const [pid] = h.setupOwn('single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'My Card', type: 'credit_card' }] }]) as [number]
    const card = h.accounts(pid).find((a) => a.name === 'My Card')!.id
    expect(h.importSuggest(pid, file('export.csv', CARD))).toMatchObject({ accountId: card, reason: 'card_layout' })
    h.accountCreate(pid, { name: 'Second Card', type: 'credit_card' })
    expect(h.importSuggest(pid, file('export.csv', CARD))).toBeNull()
    h.close()
  })

  it('the same file is matched to the account it went into, and archived accounts are never suggested', () => {
    const { h, pid, acc, importFile } = setup()
    importFile(acc('Everyday Chequing'), 'sept.csv', CHEQUING)
    expect(h.importSuggest(pid, file('totally-different-name.csv', CHEQUING))).toMatchObject({ accountId: acc('Everyday Chequing'), reason: 'same_file' })
    h.accountClose(pid, acc('Everyday Chequing'), true)
    expect(h.importSuggest(pid, file('totally-different-name.csv', CHEQUING))?.accountId).not.toBe(acc('Everyday Chequing'))
    expect(h.importSuggest(pid)?.accountId).not.toBe(acc('Everyday Chequing'))
    h.close()
  })

  it('an unreadable file still gets a suggestion from its name instead of failing', () => {
    const { h, pid, acc } = setup()
    expect(h.importSuggest(pid, { name: 'savings.pdf', base64: b64('%PDF-1.4') })).toMatchObject({ accountId: acc('Savings') })
    h.close()
  })
})
