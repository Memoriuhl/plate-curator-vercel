import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const domTests = 'tests/**/*.dom.test.{ts,tsx}'

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          include: [domTests],
          environment: 'jsdom',
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          exclude: [
            ...configDefaults.exclude,
            domTests,
            ...(process.env.FIRESTORE_EMULATOR_HOST
              ? []
              : ['tests-emulator/**']),
          ],
        },
      },
    ],
  },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
})
