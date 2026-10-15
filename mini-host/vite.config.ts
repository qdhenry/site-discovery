import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const here = import.meta.dirname

export default defineConfig({
  root: here,
  publicDir: resolve(here, '../dist'),
  cacheDir:
    process.env.MICRODOT_VITE_CACHE_DIR ?? resolve(here, 'node_modules/.vite'),
  server: { host: 'localhost', port: 5193, strictPort: true },
})
