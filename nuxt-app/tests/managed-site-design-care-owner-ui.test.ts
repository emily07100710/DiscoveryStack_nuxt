import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/audit-lab/managed-sites/design-care.vue', import.meta.url), 'utf8')
const nuxtConfig = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')

describe('managed-site owner design-care UI contract', () => {
  it('stays inside the private owner workbench and cannot be indexed or cached publicly', () => {
    expect(page).toContain("definePageMeta({ layout: 'owner' })")
    expect(page).toContain("'noindex, nofollow, noarchive'")
    const ownerRule = nuxtConfig.split('\n').find(line => line.includes("'/audit-lab/**':"))
    expect(ownerRule).toContain('noindex, nofollow, noarchive')
    expect(ownerRule).toContain('private, no-store, max-age=0')
    for (const forbidden of ['v-html', 'requireOwner', "credentials: 'include'", "from '../../../server/", 'process.env']) expect(page).not.toContain(forbidden)
  })

  it('loads an owner-scoped project list and only the selected project design-care projection', () => {
    expect(page).toContain("ownerFetch<{ projects: Project[] }>('/api/managed-sites/projects')")
    expect(page).toContain('`/api/managed-sites/projects/${selectedProjectId.value}/design-care`')
    expect(page).toContain('v-model="selectedProjectId"')
    expect(page).toContain('@change="loadCare"')
    expect(page).toContain('projects.value.find(project => project.id === Number(selectedProjectId.value))')
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!)
    expect(apiLiterals.length).toBeGreaterThan(0)
    for (const endpoint of apiLiterals) expect(endpoint).toMatch(/^\/api\/managed-sites\/projects(?:$|\/\$\{)/u)
  })

  it('shows the verified-delivery window without pretending an unstarted or expired window is active', () => {
    for (const token of [
      '尚未找到完整的正式交付收據，因此不會預先開始 30 天倒數。',
      '距離服務期結束尚有 {{ care.window.remainingDays }} 天',
      '重新部署不會重設起算日',
      '服務期已結束',
      'formatDate(care.window.startsAt)',
      'formatDate(care.window.expiresAt)',
      "not_started: '尚未開始'",
      "active: '服務期間內'",
      "expired: '已到期'",
    ]) expect(page).toContain(token)
    expect(page).toContain('care.boundaries.included')
    expect(page).toContain('care.boundaries.excluded')
  })

  it('lists only safe request projections and never exposes raw audit metadata or member contact data', () => {
    for (const field of ['request.category', 'request.description', 'request.pageReference', 'request.state', 'request.ownerReason', 'request.submittedAt', 'request.updatedAt']) expect(page).toContain(field)
    expect(page).toContain('categoryLabels[request.category]')
    expect(page).not.toMatch(/principalEmail|membershipEmail|submittedByMembershipId|auditMetadata|eventFingerprint|receiptFingerprint/iu)
    expect(page).not.toContain('JSON.stringify')
  })

  it('posts an allowed next state, customer-visible reason, and stable retry key to the existing owner route', () => {
    expect(page).toContain("method: 'POST'")
    for (const bodyField of [
      'requestId: request.id',
      'state: draft.state',
      'reason: draft.reason.trim()',
      'idempotencyKey: draft.idempotencyKey',
    ]) expect(page).toContain(bodyField)
    expect(page).toContain('required maxlength="500"')
    expect(page).toContain('@input="renewIdempotency(request.id)"')
    expect(page).toContain('@change="renewIdempotency(request.id)"')
    expect(page).toContain("actionError.value = messageFrom(error, '需求狀態未更新；請保留目前畫面後重試。')")
    expect(page).not.toMatch(/catch[\s\S]{0,240}renewIdempotency/u)
  })

  it('matches the service transition surface and removes controls from terminal requests', () => {
    expect(page).toContain("submitted: ['reviewing', 'accepted', 'in_progress', 'completed', 'declined']")
    expect(page).toContain("reviewing: ['accepted', 'in_progress', 'completed', 'declined']")
    expect(page).toContain("accepted: ['in_progress', 'completed', 'declined']")
    expect(page).toContain("in_progress: ['completed', 'declined']")
    expect(page).toContain('completed: []')
    expect(page).toContain('declined: []')
    expect(page).toContain('v-if="firstNextState(request) && drafts[request.id]"')
    expect(page).toContain('這筆需求已結案，狀態不可再變更。')
  })
})
