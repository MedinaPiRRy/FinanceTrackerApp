// @ts-nocheck -- fixed-size colour vectors and matrices are indexed directly; the checked results are covered by the tests that use this
// Test helper: reads the style definitions straight out of styles.css (the single source of truth) and does the colour maths
// (WCAG contrast, and how far apart two colours look to someone with a colour-vision difference).
import fs from 'node:fs'
import path from 'node:path'

export const CSS_FILE = path.join(__dirname, '..', 'src', 'renderer', 'styles.css')
export const css = (): string => fs.readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

export interface Rule { selector: string; decls: Record<string, string>; inMedia: string | null }

/** Every `selector { decls }` rule, with the @media condition it sits in (one level deep is all the file uses). */
export function rules(text: string = css()): Rule[] {
  const out: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  let mediaEnd = -1
  let media: string | null = null
  // find @media blocks first so we know which rules are inside which
  const blocks: { start: number; end: number; cond: string }[] = []
  const mre = /@media([^{]+)\{/g
  while ((m = mre.exec(text))) {
    let depth = 1; let i = m.index + m[0].length
    while (i < text.length && depth > 0) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++ }
    blocks.push({ start: m.index, end: i, cond: m[1].trim() })
  }
  void mediaEnd; void media
  while ((m = re.exec(text))) {
    const sel = m[1].trim()
    if (sel.startsWith('@')) continue
    const decls: Record<string, string> = {}
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':')
      if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim()
    }
    const b = blocks.find((x) => m!.index > x.start && m!.index < x.end)
    out.push({ selector: sel, decls, inMedia: b ? b.cond : null })
  }
  return out
}

/** The tokens one style defines. `light` is the base `:root` block. */
export function styleTokens(id: string, all: Rule[] = rules()): Record<string, string> {
  const sel = (r: Rule) => r.selector.split(',').map((s) => s.trim())
  const hit = all.filter((r) => r.inMedia === null && sel(r).includes(`[data-theme='${id}']`))
  const merged: Record<string, string> = {}
  for (const r of hit) Object.assign(merged, r.decls)
  return merged
}
export const systemDarkTokens = (all: Rule[] = rules()): Record<string, string> => {
  const r = all.find((x) => x.inMedia?.includes('prefers-color-scheme: dark') && x.selector.includes(':root'))
  return r ? r.decls : {}
}

// ---- colour maths
export const hex = (h: string): [number, number, number] => {
  const s = h.trim().replace('#', '')
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
}
const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
export const luminance = (h: string): number => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
export const contrast = (a: string, b: string): number => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

type V3 = [number, number, number]
const mul = (m: number[][], v: V3): V3 => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]]
const clamp = (x: number) => Math.min(1, Math.max(0, x))
// Machado et al. (2009), severity 1.0, on linear RGB
const CVD: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
}
const oklab = ([r, g, b]: V3): V3 => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const toLin = (h: string): V3 => { const [r, g, b] = hex(h); return [lin(r), lin(g), lin(b)] }
const de = (a: V3, b: V3) => 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
/** Colour difference (OKLab x 100) between two colours as seen by `mode`: 'normal', 'protan', 'deutan' or 'tritan'. */
export function deltaE(a: string, b: string, mode: 'normal' | 'protan' | 'deutan' | 'tritan' = 'normal'): number {
  const sim = (h: string): V3 => { const l = toLin(h); return mode === 'normal' ? l : (mul(CVD[mode], l).map(clamp) as V3) }
  return de(oklab(sim(a)), oklab(sim(b)))
}

// ---- what every style must define, and the checks every style must pass
export const STYLE_IDS = ['light', 'dark', 'business', 'girlmath', 'programmer', 'cozy', 'casual', 'adhd'] as const
export const COLOR_TOKENS = [
  '--bg', '--surface', '--surface-2', '--border', '--text', '--text-2', '--text-3',
  '--accent', '--accent-fill', '--accent-ink', '--accent-soft', '--focus',
  '--pos', '--neg', '--warn', '--pos-soft', '--neg-soft', '--warn-soft', '--attn-bg',
  '--series-1', '--series-2', '--series-3', '--grid'
]
export const SHAPE_TOKENS = [
  '--font', '--font-display', '--font-num', '--fs', '--r-sm', '--r-md', '--r-lg', '--shadow',
  '--card-pad', '--gap', '--row-pad', '--attn-weight', '--primary-weight', '--primary-pad'
]
export const ALL_TOKENS = [...COLOR_TOKENS, ...SHAPE_TOKENS]

const isHex = (v: string | undefined): v is string => !!v && /^#[0-9a-fA-F]{6}$/.test(v)

/** A flat list of problems with one style's colours (empty = fine). `attn` is the colour behind "needs attention" rows, if the style sets one. */
export function colourProblems(t: Record<string, string>, opts: { cvdFloor?: number } = {}): string[] {
  const bad: string[] = []
  const g = (k: string): string => t[k] ?? ''
  const text = (fg: string, bg: string, min = 4.5) => {
    if (!isHex(g(fg)) || !isHex(g(bg))) { bad.push(`${fg} / ${bg} is not a plain hex colour`); return }
    const c = contrast(g(fg), g(bg))
    if (c < min) bad.push(`${fg} on ${bg} is ${c.toFixed(2)}:1 (needs ${min}:1)`)
  }
  for (const fg of ['--text', '--text-2', '--text-3']) for (const bg of ['--bg', '--surface', '--surface-2']) text(fg, bg)
  for (const bg of ['--bg', '--surface', '--surface-2', '--accent-soft']) text('--accent', bg)
  for (const fg of ['--pos', '--neg', '--warn']) for (const bg of ['--bg', '--surface', '--surface-2']) text(fg, bg)
  text('--text', '--accent-soft'); text('--text-2', '--accent-soft')
  text('--pos', '--pos-soft'); text('--neg', '--neg-soft'); text('--warn', '--warn-soft')
  text('--accent-ink', '--accent-fill')
  text('--bg', '--text') // the toast
  if (isHex(g('--attn-bg'))) for (const fg of ['--text', '--text-2', '--neg', '--warn', '--pos', '--accent']) text(fg, '--attn-bg')
  // things that are not text but must still be seen: chart series, focus outline
  for (const s of ['--series-1', '--series-2', '--series-3']) text(s, '--surface', 3)
  for (const bg of ['--bg', '--surface', '--surface-2']) text('--focus', bg, 3)
  // chart colours must be easy to tell apart, also with a colour-vision difference
  const floor = opts.cvdFloor ?? 8
  const s = ['--series-1', '--series-2', '--series-3']
  if (s.every((k) => isHex(g(k)))) {
    for (const mode of ['normal', 'protan', 'deutan', 'tritan'] as const) {
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const d = deltaE(g(s[i]), g(s[j]), mode)
        if (d < (mode === 'normal' ? Math.max(15, floor) : floor)) bad.push(`${s[i]} and ${s[j]} look too alike (${mode}, ${d.toFixed(1)})`)
      }
    }
  }
  return bad
}
