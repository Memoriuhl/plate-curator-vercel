import { expect, test } from 'vitest'
import { isPublishStop, PUBLISH_STOPS, PUBLISH_STOP_MESSAGES } from '../../lib/publish/stop'

test('only recognized terminal stops have shared messages', () => {
  for (const stop of Object.values(PUBLISH_STOPS)) {
    expect(isPublishStop(stop)).toBe(true)
    expect(PUBLISH_STOP_MESSAGES[stop]).toEqual(expect.any(String))
  }
  for (const value of [null, undefined, '', 'unknown', 'superseded_revision', {}]) expect(isPublishStop(value)).toBe(false)
})
