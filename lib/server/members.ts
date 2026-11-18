import 'server-only'
import { firestoreMembersStore } from '../members/firestore-store'
import type { MembersStore } from '../members/types'
import { stagingFirestore } from '../gcp/firestore'

/** Resolve the production-shaped membership store in the configured staging database. */
export function membersStore(): MembersStore {
  return firestoreMembersStore(stagingFirestore())
}
