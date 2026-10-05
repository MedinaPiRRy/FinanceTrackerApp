import Papa from 'papaparse'
import { readWorkbookBuffer } from './xlsxReader'
import { toIso } from '../core/dates'

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 20_000

/**
 * Reads an uploaded statement entirely in memory (it is never copied to disk) and returns rows of cell text.
 * Supports .csv/.txt and .xlsx/.xlsm. PDF statements are not supported yet.
 */
export function readStatementRows(fileName: string, data: Uint8Array): string[][] {
  if (data.byteLength > MAX_STATEMENT_BYTES) throw new Error('That file is larger than 5 MB, which is far more than a statement should be. Is it the right file?')
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) throw new Error('PDF statements are not supported yet. Download the CSV or Excel version from your bank instead.')
  let rows: string[][]
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    const wb = readWorkbookBuffer(data)
    const name = wb.sheetNames[0]
    const sheet = name ? wb.getWorksheet(name) : undefined
    if (!sheet) throw new Error('That spreadsheet has no sheets.')
    rows = []
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row: string[] = []
      for (let c = 1; c <= sheet.colCount; c++) {
        const v = sheet.getCell(r, c).value
        const x = v !== null && typeof v === 'object' && !(v instanceof Date) ? v.result ?? null : v
        row.push(x === null ? '' : x instanceof Date ? toIso(x) : String(x))
      }
      rows.push(row)
    }
  } else if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    const text = new TextDecoder('utf-8').decode(data).replace(/^﻿/, '')
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
    rows = parsed.data
  } else {
    throw new Error('Unsupported file type. Use a .csv or .xlsx file.')
  }
  if (rows.length > MAX_ROWS) throw new Error(`That file has ${rows.length.toLocaleString()} rows. Statements are normally a few hundred; please check the file.`)
  return rows
}
