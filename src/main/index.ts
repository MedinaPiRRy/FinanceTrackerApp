import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHandlers } from './handlers'
import { dispatch } from './dispatch'

app.setName('FinanceTracker') // keeps userData (and our database folder) at %APPDATA%\FinanceTracker
process.env.FINANCE_APP_VERSION = app.getVersion()

// What only the installed app can do: close itself, start the uninstaller, and ask where to save a file.
const closeApp = () => { app.quit(); setTimeout(() => app.exit(0), 1500) } // exit for certain: an installer or uninstaller needs the app closed
const platformHooks = {
  quit: closeApp,
  startUninstaller: (): { started: boolean; message: string } => {
    if (process.platform === 'win32') {
      const dir = path.dirname(app.getPath('exe'))
      const uninstaller = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f)) : undefined
      if (!uninstaller) return { started: false, message: 'Your data is erased. The uninstaller was not found next to the app (this may be a portable copy). Remove the app from Windows Settings, Apps, or delete its folder.' }
      spawn(path.join(dir, uninstaller), [], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(closeApp, 800)
      return { started: true, message: 'Your data is erased. The uninstaller is opening and the app is closing.' }
    }
    if (process.platform === 'darwin') return { started: false, message: 'Your data is erased. To remove the app, quit it, then drag it from Applications to the Bin.' }
    return { started: false, message: 'Your data is erased. To remove the app, quit it and delete the AppImage file (or remove the package you installed).' }
  },
  saveTextFile: async (suggestedName: string, content: string): Promise<string | null> => {
    const options = { defaultPath: path.join(app.getPath('documents'), suggestedName), filters: [{ name: 'CSV file', extensions: ['csv'] }] }
    const r = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, content, 'utf8')
    return r.filePath
  }
}

const handlers = createHandlers(undefined, platformHooks)
const smoke = process.env.FINANCE_SMOKE === '1'
// Developer tool: FINANCE_SCREENSHOTS=<folder> (with FINANCE_DB pointing at a scratch folder) fills the app with sample data and saves
// pictures of the main pages, which is how the README screenshots are made. Never used in normal runs.
const screenshotDir = process.env.FINANCE_SCREENSHOTS
let mainWindow: BrowserWindow | null = null

// Only one copy of the app at a time: two copies writing the same database file would risk corrupting it.
if (!smoke && !app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } })

const iconPath = path.join(__dirname, '../../build/icon.png')

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    title: 'FinanceTracker',
    backgroundColor: '#f4f6fa',
    autoHideMenuBar: true, // clean window; press Alt to show the menu
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: !smoke,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  mainWindow = win
  win.on('closed', () => { mainWindow = null })
  // Nothing in this app should ever navigate away or open other windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  if (screenshotDir) {
    win.webContents.once('did-finish-load', () => void takeScreenshots(win, screenshotDir))
  }

  if (smoke) {
    // Self-test used when building the installer: reports whether the UI loaded and the database/helper script work.
    const report = (ok: boolean, detail: unknown) => {
      const text = JSON.stringify({ ok, detail })
      console.log('SMOKE', text)
      if (process.env.FINANCE_SMOKE_OUT) fs.writeFileSync(process.env.FINANCE_SMOKE_OUT, text)
      app.exit(ok ? 0 : 1)
    }
    win.webContents.once('did-fail-load', (_e, code, desc) => report(false, `did-fail-load ${code} ${desc}`))
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const info = await win.webContents.executeJavaScript(`(async () => ({ title: document.title, rootChildren: document.getElementById('root')?.children.length ?? 0, text: document.body.innerText.slice(0, 80), api: typeof window.financeApi, diag: await window.financeApi.call('diagnostics') }))()`)
          report(info.rootChildren > 0 && info.api === 'object' && !!info.diag?.ok, info)
        } catch (e) {
          report(false, String(e))
        }
      }, 2000)
    })
  }
}

async function takeScreenshots(win: BrowserWindow, dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const click = (label: string) => win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || x.textContent || '').trim().startsWith(${JSON.stringify(label)})); if (b) b.click(); return !!b })()`)
  const snap = async (name: string, ...clicks: string[]) => {
    for (const c of clicks) { await click(c); await wait(300) }
    await wait(1500)
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await wait(1500)
    await snap('dashboard')
    await snap('transactions', 'Transactions')
    await snap('recurring', 'Recurring')
    await snap('insights', 'Insights')
    await snap('review', 'Review')
    await snap('budget', 'Budget')
    await snap('goals', 'Goals')
    await snap('forecast', 'Forecast')
    await snap('accounts', 'Accounts')
    await snap('household-overview', 'Household', 'Overview')
    await snap('household-budget', 'Budget')
    await snap('household-accounts', 'Accounts')
    await snap('household-goals', 'Goals')
  } catch (e) { console.error('Screenshots failed', e) }
  app.exit(0)
}

ipcMain.handle('api', (_e, method: string, args: unknown[]) => dispatch(handlers as unknown as Record<string, unknown>, method, args))

void app.whenReady().then(() => {
  if (screenshotDir) { nativeTheme.themeSource = 'light'; handlers.startSample('couple_household') }
  createWindow()
})
app.on('window-all-closed', () => {
  handlers.close()
  app.quit()
})
