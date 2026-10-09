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
