import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react'

export type ThemeSetting = 'system' | 'light' | 'dark'
interface Ctx { setting: ThemeSetting; resolved: 'light' | 'dark'; setSetting(s: ThemeSetting): void }
const ThemeCtx = createContext<Ctx>({ setting: 'system', resolved: 'light', setSetting: () => {} })
export const useTheme = () => useContext(ThemeCtx)

const read = (): ThemeSetting => {
  try {
    const v = localStorage.getItem('theme')
    return v === 'light' || v === 'dark' ? v : 'system'
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
    setSettingState(s)
    try { localStorage.setItem('theme', s) } catch { /* storage unavailable: setting just won't persist */ }
  }
  const resolved = setting === 'system' ? (sysDark ? 'dark' : 'light') : setting
  return <ThemeCtx.Provider value={{ setting, resolved, setSetting }}>{children}</ThemeCtx.Provider>
}
