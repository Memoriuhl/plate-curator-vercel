import 'server-only'
import { firestoreMembersStore } from '../members/firestore-store'
import type { MembersStore } from '../members/types'
import { stagingFirestore } from '../gcp/firestore'

export function membersStore(): MembersStore {
  return firestoreMembersStore(stagingFirestore())
}
