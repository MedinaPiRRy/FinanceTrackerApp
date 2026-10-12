// Dev-only HTTP bridge so the UI can be developed and checked in a normal browser.
// Usage: FINANCE_DB=<path> npx tsx scripts/dev-api.ts   (listens on 127.0.0.1:5174 only)
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandlers } from '../src/main/handlers'
import { dispatch } from '../src/main/dispatch'

// Safety: dev mode never touches the real app database unless FINANCE_DB is set explicitly (sample data lives next to it).
process.env.FINANCE_DB ??= path.join(os.tmpdir(), 'financeapp-dev', 'finance.db')

const handlers = createHandlers() as unknown as Record<string, unknown>
http
  .createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api') { res.writeHead(404).end(); return }
    // Only the UI served by `npm run dev:web` may call this. A web page on any other origin can still send a "simple" cross-origin POST, so the
    // request has to be JSON (which makes the browser ask permission first, and this server never grants it) and must not name a foreign origin.
    const origin = req.headers.origin
    if (origin !== undefined && !/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)) { res.writeHead(403).end(); return }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415).end(); return }
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 20_000_000) req.destroy() })
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      let call: { method: string; args: unknown[] }
      try { call = JSON.parse(body) as { method: string; args: unknown[] } } catch { res.writeHead(400).end(JSON.stringify({ ok: false, error: 'The request was not valid JSON.' })); return }
      res.end(JSON.stringify(await dispatch(handlers, call.method, call.args)))
    })
  })
  .listen(5174, '127.0.0.1', () => console.log('dev api on http://127.0.0.1:5174'))
