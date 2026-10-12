// Audit: hostile or broken statement files. The importer limits a file to 5 MB, but a small file can still be built to eat memory or time.
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readStatementRows, MAX_STATEMENT_BYTES } from '../src/importers/statementFile'

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/></cellXfs></styleSheet>`
const sheet = (rows: string) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
const xlsx = (rowsXml: string, extra: Record<string, Uint8Array> = {}) =>
  zipSync({ 'xl/workbook.xml': strToU8(WORKBOOK), 'xl/_rels/workbook.xml.rels': strToU8(RELS), 'xl/styles.xml': strToU8(STYLES), 'xl/worksheets/sheet1.xml': strToU8(sheet(rowsXml)), ...extra }, { level: 9 })

describe('well-formed spreadsheets', () => {
  it('reads text, numbers and an inline string', () => {
    const rows = readStatementRows('s.xlsx', xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>2026-03-01</t></is></c><c r="B1" t="inlineStr"><is><t>COFFEE</t></is></c><c r="C1"><v>4.5</v></c></row>'))
    expect(rows).toEqual([['2026-03-01', 'COFFEE', '4.5']])
  })
  it('refuses a file over the size limit before opening it', () => {
    expect(() => readStatementRows('big.csv', new Uint8Array(MAX_STATEMENT_BYTES + 1))).toThrow(/larger than 5 MB/)
  })
  it('refuses a damaged zip with an ordinary error', () => {
    expect(() => readStatementRows('x.xlsx', strToU8('PK\u0003\u0004 not really a zip'))).toThrow()
  })
})

describe('files built to cause trouble', () => {
  // Was audit finding P-01: a 5 MB .xlsx was unzipped fully in memory with no limit on the unzipped size (a "zip bomb"). This test uses 300 MB so the suite itself stays safe.
  it('refuses a spreadsheet that unzips to far more than a statement could need (zip bomb)', () => {
    const bomb = xlsx('<row r="1"><c r="A1"><v>1</v></c></row>', { 'xl/worksheets/sheet2.xml': new Uint8Array(300 * 1024 * 1024) })
    expect(bomb.byteLength).toBeLessThan(MAX_STATEMENT_BYTES) // small enough to pass the 5 MB check
    expect(() => readStatementRows('bomb.xlsx', bomb)).toThrow()
    // an unneeded part (an image, a macro) is skipped without being unpacked at all, so it cannot hurt
    expect(() => readStatementRows('padded.xlsx', xlsx('<row r="1"><c r="A1"><v>1</v></c></row>', { 'xl/media/pad.bin': new Uint8Array(300 * 1024 * 1024) }))).not.toThrow()
  }, 60_000)

  // Was audit finding P-02: the reader walked every row number up to the largest one times the widest column (about 12 s for one cell at XFD1048576).
  it('a spreadsheet with a single cell far down and far right does not hang the importer', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-parse-')), 'far.xlsx')
    fs.writeFileSync(file, xlsx('<row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>x</t></is></c></row>'))
    const code = `import fs from 'node:fs'; import { readStatementRows } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src/importers/statementFile.ts')).href)}; try { readStatementRows('far.xlsx', fs.readFileSync(${JSON.stringify(file)})) } catch (e) {}`
    const t0 = Date.now()
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { timeout: 15_000, cwd: process.cwd() })
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    expect(timedOut).toBe(false)
    expect(Date.now() - t0).toBeLessThan(3_000) // before the fix: about 12 s of 100% CPU in the main process, during which the whole window is frozen
  }, 40_000)

  it('a CSV with one enormous unterminated quoted field is read or refused without hanging', () => {
    const text = '2026-01-01,"' + 'x'.repeat(4_000_000)
    const t0 = Date.now()
    try { readStatementRows('q.csv', new TextEncoder().encode(text)) } catch { /* refusing is fine */ }
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('a CSV with thousands of columns is read without a crash', () => {
    const line = Array.from({ length: 20000 }, (_, i) => `c${i}`).join(',')
    expect(() => readStatementRows('wide.csv', new TextEncoder().encode(line + '\n' + line))).not.toThrow(/TypeError|RangeError/)
  })

  it('more rows than the row limit is refused with a plain message', () => {
    const text = Array.from({ length: 20_001 }, (_, i) => `2026-01-01,SHOP ${i},1.00,`).join('\n')
    expect(() => readStatementRows('many.csv', new TextEncoder().encode(text))).toThrow(/rows/)
  })

  it('a sheet with a few rows but thousands of columns is refused as too wide, and a far-away cell is read as just that row', () => {
    // 150 rows, each with a cell in column A and one in column XFD (16,384): about 2.4 million cells if the sheet were laid out in full
    const wideRows = Array.from({ length: 150 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>x</t></is></c><c r="XFD${r + 1}" t="inlineStr"><is><t>y</t></is></c></row>`).join('')
    expect(() => readStatementRows('wide.xlsx', xlsx(wideRows))).toThrow(/wider than a statement/)
    const rows = readStatementRows('far.xlsx', xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="900000"><c r="B900000" t="inlineStr"><is><t>b</t></is></c></row>'))
    expect(rows).toEqual([['a', ''], ['', 'b']])
  })
})
