import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { build: { rollupOptions: { input: resolve('src/main/index.ts') } } },
  preload: { build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    server: { proxy: { '^/api$': 'http://127.0.0.1:5174' } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
