// The app's styles: which exist, what they are called, and how a saved choice is read back. The colours themselves live in styles.css.
export const STYLES = [
  { id: 'light', name: 'Light', blurb: 'The standard bright look.', dark: false },
  { id: 'dark', name: 'Dark', blurb: 'Easy on the eyes in a dim room.', dark: true },
  { id: 'business', name: 'Business', blurb: 'Navy and slate, compact and tidy, like office software.', dark: false },
  { id: 'girlmath', name: 'GirlMath', blurb: 'Soft pinks, hot-pink accents and rounded corners.', dark: false },
  { id: 'programmer', name: 'Programmer', blurb: 'A green-on-black terminal with a monospace font.', dark: true },
  { id: 'cozy', name: 'Cozy', blurb: 'Autumn creams, browns and burnt orange.', dark: false },
  { id: 'casual', name: 'Casual', blurb: 'Plain greys and one simple blue.', dark: false },
  { id: 'adhd', name: 'ADHD', blurb: 'Calm and quiet; strong colour only for what needs you: amounts owed, over budget, items to review and the main button.', dark: false }
] as const

export type StyleId = (typeof STYLES)[number]['id']
/** What is saved: a style, or "system" (Light or Dark, whichever the computer is set to). */
export type ThemeSetting = 'system' | StyleId

export const STORAGE_KEY = 'theme'
export const isStyleId = (v: unknown): v is StyleId => STYLES.some((s) => s.id === v)
/** Reads a saved value. 'system', 'light' and 'dark' from older versions work as before; anything unknown falls back to 'system'. */
export const parseSetting = (v: unknown): ThemeSetting => (isStyleId(v) ? v : 'system')
/** The style that is really shown for a setting. */
export const resolveStyle = (setting: ThemeSetting, systemDark: boolean): StyleId => (setting === 'system' ? (systemDark ? 'dark' : 'light') : setting)
