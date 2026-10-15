import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'

import { emitMicroDotManifest } from '@bespokeagentics/microdots-vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const here = import.meta.dirname

const workspacePackageSource = (name: string): string => {
  let cursor = here
  for (;;) {
    const candidate = resolve(cursor, 'packages', name, 'src')
    if (existsSync(candidate)) return candidate
    const parent = dirname(cursor)
    if (parent === cursor) {
      throw new Error(
        'Cannot find packages/' + name + '/src above compiled workspace ' + here,
      )
    }
    cursor = parent
  }
}

const emitCapabilityAggregate = {
  name: 'microdots-phase3-capability-aggregate',
  closeBundle() {
    mkdirSync(resolve(here, 'dist'), { recursive: true })
    copyFileSync(
      resolve(here, 'service/capabilities.json'),
      resolve(here, 'dist/capabilities.json'),
    )
  },
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    emitMicroDotManifest(here),
    emitCapabilityAggregate,
  ],
  resolve: {
    alias: {
      '@bespokeagentics/microdots-runtime': workspacePackageSource('microdots-runtime'),
      '@bespokeagentics/microdots-element': workspacePackageSource('microdots-element'),
      '@bespokeagentics/microdots-theme': workspacePackageSource('microdots-theme'),
      '@bespokeagentics/microdots-catalog': workspacePackageSource('microdots-catalog'),
    },
  },
  build: {
    lib: {
      entry: resolve(here, 'src/entry.ts'),
      formats: ['es'],
      fileName: () => "site-discovery.js",
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
})
