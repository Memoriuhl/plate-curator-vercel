type QueueOrder = {
  id: string
  createdAt: number
  queuedAt?: number
  enqueueSequence?: number
}

export function compareQueueOrder(a: QueueOrder, b: QueueOrder) {
  return (
    (a.enqueueSequence ?? 0) - (b.enqueueSequence ?? 0) ||
    (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
    a.id.localeCompare(b.id)
  )
}
