import type { ReactNode } from 'react'
import { useKept } from '../nav'

/** Previous / next with "rows 101 to 200 of 3,204". Used wherever a list can run to thousands of rows. */
export function Pager({ page, total, pageSize, onPage, noun = 'rows' }: { page: number; total: number; pageSize: number; onPage: (p: number) => void; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  return (
    <nav className="pager" aria-label="Pages" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', margin: '10px 0' }}>
      <span className="muted">{noun} {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button className="btn small" disabled={page === 0} onClick={() => onPage(0)} aria-label="First page">«</button>
        <button className="btn small" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="muted" aria-live="polite">Page {page + 1} of {pages.toLocaleString()}</span>
        <button className="btn small" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</button>
        <button className="btn small" disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} aria-label="Last page">»</button>
      </span>
    </nav>
  )
}

/** Every list and table shows this many rows at a time. */
export const PAGE_SIZE = 50

/**
 * Pages a list that is already in memory: `rows` is the slice to draw, `pager` goes under the table.
 * The page is remembered per `name` when the person comes back with the Back button, and snaps back into range when the list shrinks.
 */
export function usePaged<T>(items: readonly T[], name: string, noun = 'rows'): { rows: T[]; pager: ReactNode; page: number } {
  const [page, setPage] = useKept(`page:${name}`, 0)
  const last = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1)
  const at = Math.min(page, last)
  return { rows: items.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE), page: at, pager: <Pager page={at} total={items.length} pageSize={PAGE_SIZE} onPage={setPage} noun={noun} /> }
}

/** Draws a long list a page at a time: `children` gets the rows of the current page, the page controls go underneath. */
export function PagedItems<T>({ items, name, noun, children }: { items: readonly T[]; name: string; noun?: string; children: (rows: T[]) => ReactNode }) {
  const { rows, pager } = usePaged(items, name, noun)
  return <>{children(rows)}{pager}</>
}
