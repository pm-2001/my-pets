import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  // Electron loads the production build over file://, so assets must be relative.
  base: './',
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128',
  },
})
