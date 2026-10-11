export function moveInOrder(ids: string[], sourceId: string, targetId: string): string[] {
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return ids
  const next = ids.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Place source before or after target. Returns the same array when nothing moves. */
export function moveBeside(ids: string[], sourceId: string, targetId: string, after: boolean): string[] {
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return ids
  let insertAt = to + (after ? 1 : 0)
  if (from < insertAt) insertAt -= 1
  if (insertAt === from) return ids
  const next = ids.slice()
  const [item] = next.splice(from, 1)
  next.splice(insertAt, 0, item)
  return next
}

export function placeVisibleOrder(allIds: string[], visibleIds: string[]): string[] {
  const queue = visibleIds.slice()
  const visible = new Set(visibleIds)
  return allIds.map((id) => (visible.has(id) ? (queue.shift() ?? id) : id))
}
