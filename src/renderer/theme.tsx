import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react'
import { parseSetting, resolveStyle, STORAGE_KEY, type StyleId, type ThemeSetting } from './themes'

export type { ThemeSetting, StyleId } from './themes'
interface Ctx { setting: ThemeSetting; resolved: StyleId; setSetting(s: ThemeSetting): void }
const ThemeCtx = createContext<Ctx>({ setting: 'system', resolved: 'light', setSetting: () => {} })
export const useTheme = () => useContext(ThemeCtx)

const read = (): ThemeSetting => {
  try {
    return parseSetting(localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<ThemeSetting>(read)
  const [sysDark, setSysDark] = useState(systemDark)

  useLayoutEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSysDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // Layout effect so the attribute is set before chart (passive) effects read the colour tokens.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (setting === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', setting)
  }, [setting])

  const setSetting = (s: ThemeSetting) => {
    const next = parseSetting(s)
    setSettingState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* storage unavailable: setting just won't persist */ }
  }
  return <ThemeCtx.Provider value={{ setting, resolved: resolveStyle(setting, sysDark), setSetting }}>{children}</ThemeCtx.Provider>
}
