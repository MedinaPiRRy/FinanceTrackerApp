// Back / forward through the pages the person has visited, with each page exactly as they left it.
// Every visit is a history entry with its own id; a page keeps its filters, month, tab and so on in `useKept`,
// stored under that id, so going back brings the same filters back.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

export interface Entry<P, S> { id: number; page: P; preset: S }

export interface History<P, S> {
  entry: Entry<P, S>
  goto: (page: P, preset?: S) => void
  /** Start over with one entry (after switching person, leaving the sample, and so on). */
  reset: (page: P) => void
  back: () => void
  forward: () => void
  canBack: boolean
  canForward: boolean
  store: Map<string, unknown>
}

const LIMIT = 100

export function useHistory<P extends string, S extends object>(first: P, empty: S): History<P, S> {
  const nextId = useRef(1)
  const store = useRef(new Map<string, unknown>()).current
  const make = useCallback((page: P, preset: S): Entry<P, S> => ({ id: nextId.current++, page, preset }), [])
  const [state, setState] = useState(() => ({ entries: [make(first, empty)], idx: 0 }))

  const goto = useCallback((page: P, preset: S = empty) => {
    setState((s) => {
      const cur = s.entries[s.idx]!
      // clicking the page you are already on (without a preset) is not a new step
      if (cur.page === page && Object.keys(preset).length === 0 && Object.keys(cur.preset).length === 0) return s
      const entries = [...s.entries.slice(0, s.idx + 1), make(page, preset)].slice(-LIMIT)
      return { entries, idx: entries.length - 1 }
    })
  }, [make, empty])
  const reset = useCallback((page: P) => { store.clear(); setState({ entries: [make(page, empty)], idx: 0 }) }, [make, empty, store])
  const back = useCallback(() => setState((s) => (s.idx > 0 ? { ...s, idx: s.idx - 1 } : s)), [])
  const forward = useCallback(() => setState((s) => (s.idx < s.entries.length - 1 ? { ...s, idx: s.idx + 1 } : s)), [])

  // Alt+Left / Alt+Right, like a browser
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); back() } else if (e.key === 'ArrowRight') { e.preventDefault(); forward() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [back, forward])

  return { entry: state.entries[state.idx]!, goto, reset, back, forward, canBack: state.idx > 0, canForward: state.idx < state.entries.length - 1, store }
}

const KeptContext = createContext<{ entryId: number; store: Map<string, unknown> }>({ entryId: 0, store: new Map() })
export const KeptProvider = KeptContext.Provider

/** Like useState, but the value comes back when the person returns to this page with the back button. */
export function useKept<T>(name: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { entryId, store } = useContext(KeptContext)
  const key = `${entryId}:${name}`
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : typeof initial === 'function' ? (initial as () => T)() : initial))
  useEffect(() => { store.set(key, value) }, [store, key, value])
  return [value, setValue]
}
