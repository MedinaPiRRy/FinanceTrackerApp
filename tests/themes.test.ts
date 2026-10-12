import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { STYLES, parseSetting, resolveStyle, isStyleId, STORAGE_KEY } from '../src/renderer/themes'
import { ALL_TOKENS, COLOR_TOKENS, STYLE_IDS, colourProblems, contrast, css, rules, styleTokens, systemDarkTokens } from './themeCss'

const RENDERER = path.join(__dirname, '..', 'src', 'renderer')
const all = rules()

describe('app styles: definitions', () => {
  it('the list in the app and the list the tests check are the same eight styles', () => {
    expect(STYLES.map((s) => s.id)).toEqual([...STYLE_IDS])
    for (const s of STYLES) { expect(s.name.length).toBeGreaterThan(0); expect(s.blurb.length).toBeGreaterThan(10) }
  })

  for (const id of STYLE_IDS) {
    it(`${id} defines every token, and nothing unknown`, () => {
      const t = styleTokens(id, all)
      expect(ALL_TOKENS.filter((k) => !t[k] || t[k] === '')).toEqual([])
      expect(Object.keys(t).filter((k) => k.startsWith('--') && !ALL_TOKENS.includes(k))).toEqual([])
    })
  }

  it('"Match system" in a dark computer uses exactly Dark\'s colours', () => {
    const sys = systemDarkTokens(all)
    const dark = styleTokens('dark', all)
    for (const k of COLOR_TOKENS) if (k in sys) expect(sys[k], k).toBe(dark[k])
    // the system block must not apply once a style has been chosen
    const r = all.find((x) => x.inMedia?.includes('prefers-color-scheme: dark'))!
    expect(r.selector).toContain(':not([data-theme])')
  })

  it('Light and Dark look exactly as they did before styles existed', () => {
    const was = {
      light: { '--bg': '#f4f6fa', '--surface': '#ffffff', '--surface-2': '#f8f9fc', '--border': '#e3e7ef', '--text': '#0f1729', '--text-2': '#4b5568', '--text-3': '#677182', '--accent': '#266dc4', '--accent-fill': '#266dc4', '--accent-ink': '#ffffff', '--accent-soft': '#e8f1fc', '--pos': '#0b7a4b', '--neg': '#b42318', '--warn': '#9a5b00', '--warn-soft': '#fff4de', '--pos-soft': '#e6f5ee', '--neg-soft': '#fdeceb', '--series-1': '#2a78d6', '--series-2': '#eb6834', '--series-3': '#1aa976', '--grid': '#e8ebf2' },
      dark: { '--bg': '#0e1117', '--surface': '#161b24', '--surface-2': '#1b212c', '--border': '#283040', '--text': '#f1f4fa', '--text-2': '#b6bfce', '--text-3': '#8a95a8', '--accent': '#4b92e7', '--accent-fill': '#1d75df', '--accent-ink': '#ffffff', '--accent-soft': '#162a44', '--pos': '#4cc38a', '--neg': '#ff8a80', '--warn': '#f0b24b', '--warn-soft': '#33270f', '--pos-soft': '#12301f', '--neg-soft': '#3a1a18', '--series-1': '#3987e5', '--series-2': '#d95926', '--series-3': '#199e70', '--grid': '#262d3a' }
    }
    for (const id of ['light', 'dark'] as const) {
      const t = styleTokens(id, all)
      for (const [k, v] of Object.entries(was[id])) expect(t[k], `${id} ${k}`).toBe(v)
    }
    // the plain look (no choice made) is Light
    const base = all.find((x) => x.selector.startsWith(':root') && x.inMedia === null)!
    expect(base.decls['--bg']).toBe('#f4f6fa')
  })
})

describe('app styles: accessibility', () => {
  for (const id of STYLE_IDS) {
    it(`${id}: text, status colours, focus and chart colours pass the checks`, () => {
      // Dark is kept exactly as it was; its blue and green series are the one pair that is close for tritanopia (4.0, as before)
      expect(colourProblems(styleTokens(id, all), { cvdFloor: id === 'dark' ? 3.5 : 8 })).toEqual([])
    })
  }

  it('the checker really catches a failing pair', () => {
    const t = { ...styleTokens('light', all), '--text-3': '#b0b8c4' }
    expect(colourProblems(t).some((p) => p.includes('--text-3'))).toBe(true)
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0)
    const same = { ...styleTokens('light', all), '--series-2': '#2a78d7' }
    expect(colourProblems(same).some((p) => p.includes('look too alike'))).toBe(true)
  })

  it('each style keeps a clearly visible edge on cards (border against the page)', () => {
    for (const id of STYLE_IDS) {
      const t = styleTokens(id, all)
      expect(contrast(t['--border']!, t['--surface']!), id).toBeGreaterThan(1.15)
    }
  })
})

describe('app styles: no colours outside the tokens', () => {
  it('styles.css uses colour literals only inside the style definitions', () => {
    const outside = all.filter((r) => !r.selector.includes('data-theme') && !r.selector.startsWith(':root') && /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(Object.values(r.decls).join(' ')))
    expect(outside.map((r) => r.selector)).toEqual([])
  })

  it('no page or component writes a colour by hand', () => {
    const bad: string[] = []
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name)
        if (f.isDirectory()) walk(p)
        else if (/\.(tsx?)$/.test(f.name) && f.name !== 'themes.ts') {
          const src = fs.readFileSync(p, 'utf8')
          if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])|rgba?\(|hsla?\(/.test(src.replace(/&#\d+;/g, ''))) bad.push(path.relative(RENDERER, p))
        }
      }
    }
    walk(RENDERER)
    expect(bad).toEqual([])
  })

  it('every var(--x) in the styles and the pages is a token that exists', () => {
    const known = new Set<string>(ALL_TOKENS)
    const used = new Set<string>()
    const scan = (text: string) => { for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]!) }
    scan(css())
    const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name)) scan(fs.readFileSync(p, 'utf8')) } }
    walk(RENDERER)
    expect([...used].filter((k) => !known.has(k))).toEqual([])
  })
})

describe('app styles: the saved choice', () => {
  it('old saved values keep working, anything unknown falls back to "system"', () => {
    expect(parseSetting('system')).toBe('system')
    expect(parseSetting('light')).toBe('light')
    expect(parseSetting('dark')).toBe('dark')
    for (const s of STYLES) expect(parseSetting(s.id)).toBe(s.id)
    for (const bad of [null, undefined, '', 'Dark', 'neon', '__proto__', 'constructor', 7, {}, ['dark']]) expect(parseSetting(bad)).toBe('system')
    expect(isStyleId('toString')).toBe(false)
  })

  it('"system" shows Light or Dark by the computer; a chosen style shows as itself', () => {
    expect(resolveStyle('system', false)).toBe('light')
    expect(resolveStyle('system', true)).toBe('dark')
    expect(resolveStyle('cozy', true)).toBe('cozy')
    expect(resolveStyle('light', true)).toBe('light')
  })

  const runInit = (stored: unknown, throws = false) => {
    const attrs: Record<string, string> = {}
    const ctx = {
      localStorage: { getItem: (k: string) => { if (throws) throw new Error('blocked'); return k === STORAGE_KEY ? stored : null } },
      document: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v } } }
    }
    vm.runInNewContext(fs.readFileSync(path.join(RENDERER, 'public', 'theme-init.js'), 'utf8'), ctx)
    return attrs
  }

  it('the first-paint script applies a saved style, and only a known one', () => {
    for (const s of STYLES) expect(runInit(s.id)).toEqual({ 'data-theme': s.id })
    expect(runInit('system')).toEqual({})
    expect(runInit(null)).toEqual({})
    expect(runInit('neon')).toEqual({})
    expect(runInit('__proto__')).toEqual({})
    expect(runInit('dark', true)).toEqual({}) // storage blocked: no crash, default look
  })

  it('index.html loads the script before anything is drawn, and the script lists the same styles as the app', () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
    expect(html.indexOf('theme-init.js')).toBeGreaterThan(-1)
    expect(html.indexOf('theme-init.js')).toBeLessThan(html.indexOf('main.tsx'))
    expect(html).not.toMatch(/<script>[^<]/) // the security policy does not allow inline scripts
    const js = fs.readFileSync(path.join(RENDERER, 'public', 'theme-init.js'), 'utf8')
    const ids = /var ids = \[([^\]]*)\]/.exec(js)![1]!.split(',').map((x) => x.trim().replace(/'/g, ''))
    expect(ids).toEqual(STYLES.map((s) => s.id))
  })
})

describe('app styles: motion', () => {
  it('styles add no animation or transition of their own', () => {
    const text = css()
    expect(/transition\s*:/.test(text)).toBe(false)
    expect((text.match(/animation\s*:\s*(?!none)\S/g) ?? []).length).toBe(1) // the existing row flash, which already respects reduced motion
    expect(text).toContain('prefers-reduced-motion')
  })
})
