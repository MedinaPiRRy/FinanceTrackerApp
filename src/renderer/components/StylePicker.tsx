import type { ReactNode } from 'react'
import { STYLES, type ThemeSetting } from '../themes'

/** A small preview drawn with the real tokens of the style it sits in (data-theme on this element scopes them). */
function Preview({ style }: { style: string }) {
  return (
    <span className="style-preview" data-theme={style} aria-hidden="true">
      <span className="style-sample-card"><b className="style-sample-title">Groceries</b><span className="num">$482.10</span></span>
      <span className="style-sample-row"><span className="style-sample-btn">Save</span><span className="pos num">+$120</span><span className="neg num">−$64</span></span>
      <span className="style-sample-chart"><i /><i /><i /></span>
    </span>
  )
}

/**
 * The style picker: one card per style, each previewed in its own colours. A radio group, so Tab goes to the chosen card and the arrow keys
 * move between them. The change applies as soon as a card is chosen. The card itself wears the app's current colours (so its text is always
 * readable); only the little preview wears the style's.
 */
export function StylePicker({ value, onChange }: { value: ThemeSetting; onChange: (s: ThemeSetting) => void }) {
  const card = (id: ThemeSetting, name: string, blurb: string, preview: ReactNode) => (
    <label key={id} className={`style-card${value === id ? ' on' : ''}`}>
      <input type="radio" name="app-style" className="sr-only" checked={value === id} onChange={() => onChange(id)} />
      <span className="style-card-top"><b>{name}</b>{value === id && <span className="badge accent">✓ In use</span>}</span>
      <span className="style-blurb">{blurb}</span>
      {preview}
    </label>
  )
  return (
    <div role="radiogroup" aria-label="App style" className="style-grid">
      {card('system', 'Match system', 'Light or Dark, following your computer.', <span className="style-split"><Preview style="light" /><Preview style="dark" /></span>)}
      {STYLES.map((s) => card(s.id, s.name, s.blurb, <Preview style={s.id} />))}
    </div>
  )
}
