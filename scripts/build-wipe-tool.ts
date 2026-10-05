// Builds "<App>-Wipe-Data.exe" into dist/ with the C# compiler that ships with Windows (no extra tools needed).
// Run automatically by `npm run dist:win`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')) as { build: { productName: string } }
const app = pkg.build.productName
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!fs.existsSync(csc)) {
  console.warn(`Skipped the wipe tool: ${csc} was not found.`)
  process.exit(0)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-tool-'))
const src = path.join(tmp, 'WipeData.cs')
fs.writeFileSync(src, fs.readFileSync(path.join(__dirname, 'WipeData.cs'), 'utf8').replaceAll('__APP__', app))
const dist = path.join(__dirname, '../dist')
fs.mkdirSync(dist, { recursive: true })
const out = path.join(dist, `${app}-Wipe-Data.exe`)
execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${out}`, '/reference:System.Windows.Forms.dll', src], { stdio: 'inherit' })
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`Wrote dist/${app}-Wipe-Data.exe`)
