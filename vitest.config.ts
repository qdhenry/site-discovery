import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts', 'service/**/*.test.ts', '*.test.ts'], exclude: ['**/*.bun.test.ts'], passWithNoTests: true } })
