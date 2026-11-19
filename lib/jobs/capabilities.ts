import { imageGroupCapabilities } from './image-options'
import type { JobsDeps } from './types'

export type Availability = { available: boolean; reason?: string }
export type LocalWorkerCapabilities = {
  group: Availability
  embeddings: Availability
  mask: Availability
  vision: Availability
  enhanceImage?: Availability
  pollIntervalMs: number
}
export type WorkerCapabilityRecord = {
  workerId: string
  reportedAt: number
  supportsSavedSources?: boolean
  capabilities: LocalWorkerCapabilities
}

/**
 * Decide when a capability heartbeat warrants a write so identical reports can wait for
 * the next polling interval.
 */
export function shouldWriteCapabilities(
  previous: WorkerCapabilityRecord | null,
  record: WorkerCapabilityRecord
): boolean {
  if (!previous) return true
  if (record.reportedAt < previous.reportedAt) return false
  return (
    !sameCapabilities(previous, record) ||
    record.reportedAt - previous.reportedAt >=
      record.capabilities.pollIntervalMs
  )
}

/** Compare the parts of two heartbeats that the dashboard shows. */
function sameCapabilities(
  previous: WorkerCapabilityRecord,
  record: WorkerCapabilityRecord
): boolean {
  return (
    previous.workerId === record.workerId &&
    previous.supportsSavedSources === record.supportsSavedSources &&
    previous.capabilities.pollIntervalMs ===
      record.capabilities.pollIntervalMs &&
    (['group', 'embeddings', 'mask', 'vision', 'enhanceImage'] as const).every(
      (key) =>
        previous.capabilities[key]?.available ===
          record.capabilities[key]?.available &&
        previous.capabilities[key]?.reason === record.capabilities[key]?.reason
    )
  )
}

/**
 * Decide whether a stored heartbeat changes what the dashboard shows: a new worker,
 * different availability, or a worker reporting again after it went stale. Routine
 * refreshes of an unchanged worker do not.
 */
export function capabilitiesVisiblyChanged(
  previous: WorkerCapabilityRecord | null,
  record: WorkerCapabilityRecord
): boolean {
  return (
    !previous ||
    !sameCapabilities(previous, record) ||
    record.reportedAt - previous.reportedAt >
      2 * previous.capabilities.pollIntervalMs
  )
}

/**
 * Validate a worker capability report before storing limits and feature availability
 * from a local worker.
 */
export function parseWorkerCapabilities(
  value: unknown
): LocalWorkerCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'group',
          'embeddings',
          'mask',
          'vision',
          'enhanceImage',
          'pollIntervalMs',
        ].includes(key)
    ) ||
    !Number.isInteger(input.pollIntervalMs) ||
    Number(input.pollIntervalMs) < 100 ||
    Number(input.pollIntervalMs) > 60000
  )
    return null
  const entries: [string, Availability][] = []
  for (const key of [
    'group',
    'embeddings',
    'mask',
    'vision',
    ...(input.enhanceImage === undefined ? [] : ['enhanceImage']),
  ]) {
    const raw = input[key]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (
      typeof item.available !== 'boolean' ||
      Object.keys(item).some((key) => !['available', 'reason'].includes(key))
    )
      return null
    if (
      item.reason !== undefined &&
      (typeof item.reason !== 'string' ||
        !item.reason.trim() ||
        item.reason.length > 200)
    )
      return null
    if (!item.available && !item.reason) return null
    entries.push([
      key,
      {
        available: item.available,
        ...(item.reason ? { reason: String(item.reason).trim() } : {}),
      },
    ])
  }
  return {
    ...Object.fromEntries(entries),
    pollIntervalMs: Number(input.pollIntervalMs),
  } as LocalWorkerCapabilities
}

/**
 * Record a validated heartbeat so the dashboard can advertise the worker's current
 * capabilities.
 */
export async function reportLocalWorkerCapabilities(
  d: JobsDeps,
  workerId: string,
  input: unknown,
  supportsSavedSources?: boolean
): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1' || !d.localScope)
    return false
  const capabilities = parseWorkerCapabilities(input)
  if (!capabilities) return false
  await d.store.writeCapabilities(d.localScope, {
    workerId,
    reportedAt: d.now(),
    capabilities,
    ...(supportsSavedSources === undefined ? {} : { supportsSavedSources }),
  })
  return true
}

/**
 * Load the local worker's capabilities and interpret its heartbeat age for queue
 * controls.
 */
export async function readLocalWorkerCapabilities(d: JobsDeps) {
  const record =
    process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && d.localScope
      ? await d.store.readCapabilities(d.localScope)
      : null
  const fresh =
    record &&
    record.reportedAt <= d.now() &&
    d.now() - record.reportedAt <= 2 * record.capabilities.pollIntervalMs
  if (!fresh) {
    const result = imageGroupCapabilities()
    const unavailable = {
      available: false,
      reason: 'Local worker not reporting',
    }
    return {
      ...result,
      'find-image': unavailable,
      'enhance-image': unavailable,
      group: unavailable,
      embeddings: unavailable,
      colorSignal: unavailable,
      backgroundMask: unavailable,
      visionTiebreak: unavailable,
      reportedAt: record?.reportedAt ?? null,
      pollIntervalMs: record?.capabilities.pollIntervalMs ?? null,
    }
  }
  const caps = record.capabilities
  return {
    ...imageGroupCapabilities(),
    'enhance-image': caps.enhanceImage ?? {
      available: false,
      reason: 'Update the local worker to enhance images',
    },
    ...(record.supportsSavedSources === undefined
      ? {}
      : { supportsSavedSources: record.supportsSavedSources }),
    group: caps.group,
    embeddings: caps.embeddings,
    colorSignal: caps.mask,
    backgroundMask: caps.mask,
    visionTiebreak: caps.vision,
    reportedAt: record.reportedAt,
    pollIntervalMs: caps.pollIntervalMs,
  }
}
