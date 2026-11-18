import { expect, test } from 'vitest'
import { publishRequesterStop } from '../../lib/publish/authority'
const requestedBy = {
  uid: 'requester',
  email: 'owner@example.com',
  authorityEpoch: 2,
}
const member = {
  uid: 'requester',
  role: 'owner',
  status: 'active',
  authorityEpoch: 2,
}
test('only the same current active Owner authority may advance', () => {
  expect(publishRequesterStop(requestedBy, member)).toBeNull()
  for (const changed of [
    null,
    { ...member, uid: null },
    { ...member, uid: 'other' },
    { ...member, role: 'editor' },
    { ...member, status: 'pending' },
    { ...member, authorityEpoch: 4 },
  ]) {
    expect(publishRequesterStop(requestedBy, changed)).toBe('revoked')
  }
})
test('a command without an authority marker is superseded', () => {
  expect(publishRequesterStop(undefined, member)).toBe('superseded')
  expect(
    publishRequesterStop({ ...requestedBy, authorityEpoch: undefined }, member)
  ).toBe('superseded')
})
