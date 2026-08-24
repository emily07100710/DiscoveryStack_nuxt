import type { ContentOperationsRepository } from './repository'
import { createContentOperationsRepository } from './repository'
import { materializeOwnerDueContent, CONTENT_OPERATIONS_MAX_TICK_ENTRIES, getDefaultContentOperationsClock } from './service'
import type { Clock, ContentOperationCalendarEntryRow } from './types'

export type ContentOperationsTickInput = {
  ownerUserId: number
  repository?: ContentOperationsRepository
  clock?: Clock
  leaseOwner?: string
  maxEntries?: number
}

export type ContentOperationsTickResult = {
  selected: number
  materialized: number
  skipped: number
  leaseConflicts: number
  calendarIds: number[]
  limitations: string[]
}

export async function runContentOperationsTick(input: ContentOperationsTickInput): Promise<ContentOperationsTickResult> {
  const repository = input.repository || createContentOperationsRepository()
  const clock = input.clock || getDefaultContentOperationsClock()
  const maxEntries = Math.max(1, Math.min(input.maxEntries || CONTENT_OPERATIONS_MAX_TICK_ENTRIES, CONTENT_OPERATIONS_MAX_TICK_ENTRIES))
  const clients = await repository.listClients(input.ownerUserId)
  const activeClientIds = new Set(clients.filter(client => client.status === 'active').map(client => client.id))
  const calendars = (await repository.listCalendars(input.ownerUserId)).filter(calendar => activeClientIds.has(calendar.clientId) && calendar.status !== 'archived' && calendar.status !== 'paused')
  const candidates: Array<{ calendarId: number; entry: ContentOperationCalendarEntryRow }> = []
  for (const calendar of calendars) {
    const nowLocalDate = clock.localDate(clock.now(), calendar.timeZone)
    const entries = await repository.listEntries(input.ownerUserId, calendar.id)
    for (const entry of entries) {
      if (entry.status === 'planned' && entry.plannedLocalDate <= nowLocalDate) candidates.push({ calendarId: calendar.id, entry })
    }
  }
  candidates.sort((left, right) => left.entry.plannedLocalDate.localeCompare(right.entry.plannedLocalDate) || left.entry.scheduleKey.localeCompare(right.entry.scheduleKey) || left.entry.id - right.entry.id)
  const selected = candidates.slice(0, maxEntries)
  let materialized = 0
  let skipped = 0
  let leaseConflicts = 0
  const calendarIds = new Set<number>()
  for (const candidate of selected) {
    const result = await materializeOwnerDueContent(input.ownerUserId, { calendarId: candidate.calendarId, clock, maxEntries: 1, onlyEntryIds: [candidate.entry.id], leaseOwner: input.leaseOwner || `content-operations-tick:${process.pid}` }, repository)
    calendarIds.add(candidate.calendarId)
    materialized += result.dueWork.length
    skipped += result.entries.filter(entry => entry.id === candidate.entry.id && entry.status === 'skipped').length
    if (!result.dueWork.length && !result.entries.some(entry => entry.id === candidate.entry.id && entry.status === 'skipped')) leaseConflicts += 1
  }
  return { selected: selected.length, materialized, skipped, leaseConflicts, calendarIds: [...calendarIds].sort((a, b) => a - b), limitations: ['bounded durable materialization only', 'no provider, CMS, website, publication, review approval, or outcome collection'] }
}
