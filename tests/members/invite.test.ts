import { expect, it } from 'vitest'
import { createInvite, generateInviteToken, hashInviteToken } from '../../lib/members/invite'
import { memberStatus } from '../../lib/members/member'
import type { Member } from '../../lib/members/types'

it('generates random URL-safe tokens containing at least 32 bytes', () => {
  const tokens = Array.from({ length: 50 }, generateInviteToken)
  expect(new Set(tokens).size).toBe(tokens.length)
  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(token, 'base64url').byteLength).toBeGreaterThanOrEqual(32)
  }
})

it('hashes using SHA-256 hex and issues invites for exactly seven days', () => {
  expect(hashInviteToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(createInvite('abc', () => '2026-11-16T12:00:00.000Z')).toEqual({ tokenHash: hashInviteToken('abc'), issuedAt: '2026-11-16T12:00:00.000Z', expiresAt: '2026-11-23T12:00:00.000Z' })
})

it('derives expiry only for pending Members with invites, including the expiry boundary', () => {
  const member: Member = { email: 'person@example.com', role: 'editor', signIn: 'google', status: 'pending', invite: createInvite('token', () => '2026-11-16T12:00:00.000Z'), uid: null, invitedBy: null, createdAt: '2026-11-16T12:00:00.000Z' }
  expect(memberStatus(member, '2026-11-23T11:59:59.999Z')).toBe('pending')
  expect(memberStatus(member, '2026-11-23T12:00:00.000Z')).toBe('expired')
  expect(memberStatus(member, '2026-11-24T12:00:00.000Z')).toBe('expired')
  expect(memberStatus({ ...member, status: 'active' }, '2026-11-24T12:00:00.000Z')).toBe('active')
  expect(memberStatus({ ...member, invite: null }, '2026-11-24T12:00:00.000Z')).toBe('pending')
  expect(member.status).toBe('pending')
})
