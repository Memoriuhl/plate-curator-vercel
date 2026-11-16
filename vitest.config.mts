import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'client', include: ['tests/client/hooks.test.ts'], environment: 'jsdom' } },
      { extends: true, test: { name: 'node', exclude: [...configDefaults.exclude, 'tests/client/hooks.test.ts', ...(process.env.FIRESTORE_EMULATOR_HOST ? [] : ['tests-emulator/**'])] } },
    ],
  },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
})
