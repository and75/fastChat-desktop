import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    // Il preload gira in sandbox: può fare require solo di 'electron',
    // quindi tutto il resto va incluso nel bundle.
    build: { externalizeDeps: false },
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
