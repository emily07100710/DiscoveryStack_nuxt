import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/audit-lab/measurement-operations/runs.vue', import.meta.url), 'utf8')
const parent = readFileSync(new URL('../pages/audit-lab/measurement-operations.vue', import.meta.url), 'utf8')

describe('owner measurement scheduling and retry UI contract', () => {
  it('uses only the approved measurement collection API surface', () => {
    for (const endpoint of [
      '/api/measurement-collection/workspace',
      '/api/measurement-collection/entries/${id}/schedule',
      '/api/measurement-collection/runs/${run.id}/retry',
      '/api/measurement-collection/runs/${run.id}/dry-run',
      '/api/content-operations/workspace',
    ]) expect(page).toContain(endpoint)
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!)
    expect(apiLiterals.length).toBeGreaterThan(0)
    const allowed = ['/api/measurement-collection/', '/api/content-operations/workspace']
    for (const literal of apiLiterals) expect(allowed.some(prefix => literal.startsWith(prefix)), `unexpected API literal: ${literal}`).toBe(true)
  })

  it('keeps the page owner-only, indexed nowhere, and handles collection states', () => {
    expect(page).toContain("definePageMeta({ layout: 'owner' })")
    expect(page).toContain("'noindex, nofollow, noarchive'")
    expect(page).toContain('OwnerAsyncState')
    expect(page.match(/OwnerPager/gu)).toHaveLength(2)
    expect(page).toContain('filteredEntries')
    expect(page).toContain('filteredRuns')
    expect(page).toContain('runState')
    for (const forbidden of ['v-html', "credentials: 'include'", "from '../../server/", 'TODO']) expect(page).not.toContain(forbidden)
  })

  it('shows capability truth and a provider-free dry-run', () => {
    for (const capability of ['schedulerAvailable', 'realGoogleOAuth', 'realProviderCalls', 'outcomeCollectionConfigured']) expect(page).toContain(capability)
    expect(page).toContain('workspace.limitations')
    expect(page).toContain('Dry-run（不會呼叫 provider）')
    expect(page).toContain('未呼叫任何 provider')
  })

  it('describes scheduling by the connection fan-out the server actually performs, not one fixed set per entry', () => {
    // service.ts creates one run per (status='configured' && allowedPageScope hit) connection x checkpoint.
    expect(page).toContain('scheduleScopeLimitation')
    expect(page).toContain('狀態是 configured、且 allowedPageScope 命中此內容 canonical page 的測量連線')
    expect(page).toContain('端點仍會回 200，但實際建立 0 筆')
    expect(page).not.toContain('每個有效 delivered entry 會固定建立')
  })

  it('never reports a zero-result schedule as success, and discloses that scheduling blocks stale runs', () => {
    // blockStaleRuns() flips mismatched runs that are neither succeeded nor cancelled to blocked, but the
    // reported total is runs.length: one row per connection x checkpoint, new or an idempotent replay.
    expect(page).toContain('const scheduled = Number(result?.scheduled || 0)')
    expect(page).toContain('scheduleFeedback[id] = scheduled === 0')
    expect(page).toContain('沒有建立任何 checkpoint run')
    expect(page).toContain('scheduleInvalidationLimitation')
    expect(page).toContain('就會被改為 blocked')
    expect(page).toContain('回報的筆數只算這次排程對應到的「測量連線 × checkpoint」組合')
    expect(page).toContain('不是作廢的筆數')
    expect(page).toContain('回報 ${scheduled} 筆這次對應到的 checkpoint run')
    expect(page).not.toContain('計入回報的筆數')
    expect(page).not.toContain('已建立或重播 ')
  })

  it('marks every hardcoded capability as a server-side constant and drops the branches those constants make dead', () => {
    // Only realGoogleOAuth is computed; schedulerAvailable/outcomeCollectionConfigured/realProviderCalls are literals.
    expect(page).toContain('capabilityLimitation')
    expect(page).toContain('schedulerAvailable、outcomeCollectionConfigured、realProviderCalls 三個都是 server 端寫死的常數')
    expect(page).toContain('schedulerAvailable = {{ workspace.capabilities.schedulerAvailable }}')
    expect(page).toContain('outcomeCollectionConfigured = {{ workspace.capabilities.outcomeCollectionConfigured }}')
    expect(page).toContain('realProviderCalls = {{ workspace.capabilities.realProviderCalls }}')
    expect(page).not.toMatch(/realProviderCalls \? '已執行'/u)
    expect(page).not.toContain('Scheduler 未配置')
    expect(page).not.toContain('建立排程紀錄（不會自動執行）')
    expect(page).toContain('providerCallLimitation')
    expect(page).toContain('content-operations:measurement-tick')
    expect(page).toContain('會透過 adapter 真的呼叫 Google API')
  })

  it('styles action feedback from an explicit failure flag, never from the message text', () => {
    expect(page).toContain('type ActionFeedback = { message: string; failed: boolean }')
    expect(page).toContain('function scheduleFailed(id: number) { return scheduleFeedback[id]?.failed === true }')
    expect(page).toContain('function runFailed(id: number) { return runFeedback[id]?.failed === true }')
    expect(page).toContain("scheduleFailed(entryId(entry)) ? 'notice--error' : 'notice--success'")
    expect(page).toContain("runFailed(run.id) ? 'notice--error' : 'notice--success'")
    expect(page).not.toContain("includes('無法')")
    for (const failurePath of ['scheduleFeedback[id] = { failed: true', 'runFeedback[run.id] = { failed: true']) expect(page).toContain(failurePath)
  })

  it('builds schedulable entries from the content-operations workspace, not from a field the server never returns', () => {
    expect(page).not.toMatch(/entries\?: Entry\[\]/u)
    expect(page).not.toContain('workspace.value?.entries')
    expect(page).not.toContain('workspace.entries?.length')
    expect(page).toContain("['delivered', 'completed'].includes(String(entry.status))")
    expect(page).toContain('clientByCalendar')
    expect(page).toContain("origin: 'content_operations'")
    expect(page).toContain("origin: 'existing_run'")
    expect(page).toContain('entrySourceLimitation')
    expect(page).toContain('Promise.allSettled')
    expect(page).toContain('contentEntriesError')
  })

  it('only enables retry for states and attempts the handler accepts', () => {
    expect(page).toContain("run.state !== 'succeeded' && run.state !== 'processing' && Number(run.attemptNumber) < 3")
    expect(page).toContain('目前 attempt')
    expect(page).toContain('<details class="advanced">')
  })

  it('wires the parent to render its nested route and provides an entry link', () => {
    expect(parent).toContain('<NuxtPage v-if="isNestedRoute"')
    expect(parent).toContain("route.path.startsWith('/audit-lab/measurement-operations/')")
    expect(parent).toContain('to="/audit-lab/measurement-operations/runs"')
  })
})
