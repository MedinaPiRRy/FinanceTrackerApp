// Browser-only dev server for the UI (talks to scripts/dev-api.ts). The real app runs in Electron.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  server: { port: 5173, proxy: { '^/api$': 'http://127.0.0.1:5174' } }
})
