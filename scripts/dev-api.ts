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
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      const { method, args } = JSON.parse(body) as { method: string; args: unknown[] }
      res.end(JSON.stringify(await dispatch(handlers, method, args)))
    })
  })
  .listen(5174, '127.0.0.1', () => console.log('dev api on http://127.0.0.1:5174'))
