// Audit: the developer-only HTTP bridge (scripts/dev-api.ts). It is not part of the installed app (electron-builder packs only out/**), but anyone who runs it
// against real data has a local web server that accepts commands. This starts it on a scratch database and talks to it like a web page would.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

let child: ChildProcess
let dir: string
let log = ''
const PORT = 5174

const post = (body: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api', method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
    let b = ''
    res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
  })
  req.on('error', reject)
  req.end(body)
})

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-bridge-'))
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev-api.ts'], { cwd: process.cwd(), env: { ...process.env, FINANCE_DB: path.join(dir, 'finance.db') } })
  child.stdout?.on('data', (d) => (log += d)); child.stderr?.on('data', (d) => (log += d))
  for (let i = 0; i < 60 && !log.includes('dev api on'); i++) await new Promise((r) => setTimeout(r, 250))
}, 30_000)
afterAll(() => { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* the database may still be closing */ } })

describe('the dev bridge', () => {
  it('listens on the loopback address only', () => {
    expect(log).toContain('127.0.0.1:5174')
  })

  // Was audit finding S-01: a web page the developer happens to visit could send a "simple" cross-origin POST (Content-Type: text/plain needs no
  // CORS pre-flight) and the bridge ran the command, including "eraseAll".
  it('refuses a request that comes from another web origin, or that is not JSON', async () => {
    const other = await post(JSON.stringify({ method: 'diagnostics', args: [] }), { 'content-type': 'application/json', origin: 'https://evil.example' })
    expect(other.status).toBe(403)
    const simple = await post(JSON.stringify({ method: 'diagnostics', args: [] }), { 'content-type': 'text/plain' })
    expect(simple.status).toBe(415)
    const noType = await post(JSON.stringify({ method: 'diagnostics', args: [] }))
    expect(noType.status).toBe(415)
  })

  it('still answers the dev UI (its own origin, JSON, or no origin at all)', async () => {
    for (const headers of [{ 'content-type': 'application/json', origin: 'http://localhost:5173' }, { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' }, { 'content-type': 'application/json' }]) {
      const r = await post(JSON.stringify({ method: 'status', args: [] }), headers as Record<string, string>)
      expect(r.status).toBe(200)
      expect(JSON.parse(r.body)).toMatchObject({ ok: true })
    }
  })

  // Was audit finding S-02: a request body that is not JSON threw inside an async callback with no handler, which ended the whole bridge process.
  it('survives a request whose body is not JSON', async () => {
    const r = await post('this is not json', { 'content-type': 'application/json' })
    expect(r.status).toBe(400)
    await new Promise((r) => setTimeout(r, 500))
    expect(child.exitCode).toBeNull()
  })
})
