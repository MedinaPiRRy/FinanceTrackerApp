import { contextBridge, ipcRenderer } from 'electron'

// The only door between the UI and the rest of the computer: one function that calls a named handler.
contextBridge.exposeInMainWorld('financeApi', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, args) as Promise<{ ok: boolean; data?: unknown; error?: string }>
})
