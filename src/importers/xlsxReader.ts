// Minimal, read-only .xlsx/.xlsm reader. Works on the raw XML so it is fast, never executes macros,
// and does not choke on form controls / extension lists the way heavier libraries can.
import { unzipSync, strFromU8 } from 'fflate'
import { XMLParser } from 'fast-xml-parser'

export type CellValue = string | number | boolean | Date | { formula: true; result?: string | number | boolean | Date | null; text?: string } | null

export interface Sheet {
  name: string
  rowCount: number
  colCount: number
  getCell(row: number, col: number): { value: CellValue }
}

export interface Workbook {
  sheetNames: string[]
  getWorksheet(name: string): Sheet | undefined
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  isArray: (name) => ['row', 'c', 'si', 'xf', 'sheet', 'Relationship', 'numFmt', 'r'].includes(name)
})

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** XML numeric character references and Excel's _xHHHH_ escapes are not decoded by the parser. */
function decodeText(t: string): string {
  return t
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
}

function colToNum(ref: string): number {
  let n = 0
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86_400_000))
}

function textOf(node: unknown): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>
    if ('t' in o) return textOf(o.t)
    if ('#text' in o) return String(o['#text'])
    if ('r' in o) return (o.r as unknown[]).map((r) => textOf((r as Record<string, unknown>).t)).join('')
  }
  return String(node)
}

/** Same reader for in-memory files (e.g. an uploaded statement); nothing is written to disk. */
export function readWorkbookBuffer(data: Uint8Array): Workbook {
  const zip = unzipSync(new Uint8Array(data))
  const read = (p: string) => (zip[p] ? strFromU8(zip[p]) : '')

  const wbXml = parser.parse(read('xl/workbook.xml')).workbook
  const rels = parser.parse(read('xl/_rels/workbook.xml.rels')).Relationships.Relationship as Record<string, string>[]
  const relTarget = new Map(rels.map((r) => [r['@_Id']!, r['@_Target']!]))

  const sstXml = read('xl/sharedStrings.xml')
  const shared: string[] = sstXml ? (parser.parse(sstXml).sst.si as unknown[]).map((x) => decodeText(textOf(x))) : []

  // date detection from styles
  const styles = parser.parse(read('xl/styles.xml')).styleSheet
  const customFmt = new Map<number, string>()
  for (const nf of (styles.numFmts?.numFmt ?? []) as Record<string, string>[]) customFmt.set(Number(nf['@_numFmtId']), nf['@_formatCode']!)
  const isDateStyle: boolean[] = ((styles.cellXfs?.xf ?? []) as Record<string, string>[]).map((xf) => {
    const id = Number(xf['@_numFmtId'])
    if (BUILTIN_DATE_FMT.has(id)) return true
    const code = customFmt.get(id)
    return !!code && /[dmyh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '')) && !/^0|#/.test(code.trim())
  })

  const sheetDefs = (wbXml.sheets.sheet as Record<string, string>[]).map((s) => ({ name: s['@_name']!, rid: s['@_r:id']! }))
  const cache = new Map<string, Sheet>()

  return {
    sheetNames: sheetDefs.map((s) => s.name),
    getWorksheet(name: string) {
      const def = sheetDefs.find((s) => s.name === name)
      if (!def) return undefined
      const hit = cache.get(name)
      if (hit) return hit
      const target = relTarget.get(def.rid)!
      const xml = parser.parse(read(target.startsWith('/') ? target.slice(1) : `xl/${target}`))
      const rows = (xml.worksheet.sheetData?.row ?? []) as Record<string, unknown>[]
      const grid = new Map<number, Map<number, CellValue>>()
      let maxRow = 0
      let maxCol = 0
      for (const row of rows) {
        const r = Number(row['@_r'])
        maxRow = Math.max(maxRow, r)
        const cells = new Map<number, CellValue>()
        for (const c of (row.c ?? []) as Record<string, unknown>[]) {
          const ref = String(c['@_r'])
          const col = colToNum(ref.replace(/\d+/g, ''))
          maxCol = Math.max(maxCol, col)
          const t = c['@_t'] as string | undefined
          const hasFormula = c.f !== undefined
          const raw = c.v === undefined ? undefined : String(typeof c.v === 'object' ? (c.v as Record<string, unknown>)['#text'] ?? '' : c.v)
          let value: string | number | boolean | Date | null = null
          if (t === 'inlineStr') value = decodeText(textOf(c.is))
          else if (raw !== undefined && raw !== '') {
            if (t === 's') value = shared[Number(raw)] ?? ''
            else if (t === 'str' || t === 'e') value = decodeText(raw)
            else if (t === 'b') value = raw === '1'
            else {
              const n = Number(raw)
              value = isDateStyle[Number(c['@_s'] ?? 0)] ? serialToDate(n) : n
            }
          }
          if (hasFormula) {
            const f = c.f
            const text = typeof f === 'string' ? f : f && typeof f === 'object' ? String((f as Record<string, unknown>)['#text'] ?? '') : ''
            cells.set(col, { formula: true, result: value, text: decodeText(text) })
          }
          else if (value !== null) cells.set(col, value)
        }
        grid.set(r, cells)
      }
      const sheet: Sheet = {
        name,
        rowCount: maxRow,
        colCount: maxCol,
        getCell: (r, c) => ({ value: grid.get(r)?.get(c) ?? null })
      }
      cache.set(name, sheet)
      return sheet
    }
  }
}
