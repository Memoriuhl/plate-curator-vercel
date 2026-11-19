/**
 * Change topics that browsers listen to instead of polling. The server bumps a topic's
 * signal after it commits a change to that area, and listeners refetch their own data.
 * `pipeline` covers every jobs write; `gateway` covers only hosted jobs, so the Gateway
 * list does not refetch on every local pipeline change.
 */
export const changeTopics = [
  'pipeline',
  'gateway',
  'research',
  'publish',
] as const
export type ChangeTopic = (typeof changeTopics)[number]

/**
 * Topic signals share the batch revision collection, so the existing grant-gated
 * Firestore rule for `curatorLive/{envKey}/batchRevisions/{id}` covers them. Batch ids
 * are UUIDs or match `[a-zA-Z0-9_-]` and never contain a colon, so the ids cannot
 * collide.
 */
export function topicSignalId(topic: ChangeTopic): string {
  return `topic:${topic}`
}
