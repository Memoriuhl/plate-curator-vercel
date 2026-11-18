import { Firestore } from '@google-cloud/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'Run emulator tests with npm run test:emulator on localhost:8080'
  )
}

export const db = new Firestore({ projectId: 'demo-plate-curator' })
