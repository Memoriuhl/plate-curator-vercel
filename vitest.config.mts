import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          include: [
            'tests/client/pipeline-queue.test.tsx',
            'tests/research/ui.test.tsx',
            'tests/standard-confirmation.test.tsx',
            'tests/publish-control-ui.test.tsx',
            'tests/shared-batch-live.test.tsx',
            'tests/shared-batch-lifecycle.test.tsx',
            'tests/shared-batch-conflicts.test.tsx',
            'tests/invite-page.test.tsx',
            'tests/members-page.test.tsx',
            'tests/sign-in-form.test.tsx',
            'tests/client/session.test.tsx',
            'tests/client/hooks.test.ts',
            'tests/plate-page.test.tsx',
            'tests/grid-feel-interactions.test.tsx',
            'tests/plate-drag.test.tsx',
            'tests/client/navigation-layout.test.tsx',
            'tests/client/review-comparison.test.tsx',
          ],
          environment: 'jsdom',
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          exclude: [
            ...configDefaults.exclude,
            'tests/client/pipeline-queue.test.tsx',
            'tests/research/ui.test.tsx',
            'tests/standard-confirmation.test.tsx',
            'tests/publish-control-ui.test.tsx',
            'tests/shared-batch-live.test.tsx',
            'tests/shared-batch-lifecycle.test.tsx',
            'tests/shared-batch-conflicts.test.tsx',
            'tests/invite-page.test.tsx',
            'tests/members-page.test.tsx',
            'tests/sign-in-form.test.tsx',
            'tests/client/session.test.tsx',
            'tests/client/hooks.test.ts',
            'tests/plate-page.test.tsx',
            'tests/grid-feel-interactions.test.tsx',
            'tests/plate-drag.test.tsx',
            'tests/client/navigation-layout.test.tsx',
            'tests/client/review-comparison.test.tsx',
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
