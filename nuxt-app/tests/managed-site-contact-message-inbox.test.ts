import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { listManagedSiteContactMessages, makeContactMessageRepository } from '../server/managed-sites/contact-form/inbox-service'
import type { ManagedSiteContactSubmission } from '../server/database/schema'

const actor = { ownerUserId: 1, projectId: 7, role: 'administrator' as const }
function row(id = 1): ManagedSiteContactSubmission { return { id, projectId: 7, submittedName: 'Synthetic Visitor', submittedEmail: 'fixture@example.com', submittedPhone: null, submittedMessage: '<script>alert(1)</script>\nSynthetic message', status: 'forward_failed', forwardTargetEmail: null, forwardedAt: null, forwardErrorCode: 'provider_rejected', requestFingerprint: 'private-fingerprint', dedupeKey: 'private-dedupe', createdAt: new Date('2026-10-06T00:00:00Z') } }

describe('customer contact message inbox', () => {
  it.each(['editor', 'reviewer', 'analyst'] as const)('denies %s before loading visitor PII', async role => {
    const list = vi.fn()
    await expect(listManagedSiteContactMessages({ ...actor, role }, {}, { list })).rejects.toMatchObject({ statusCode: 403 })
    expect(list).not.toHaveBeenCalled()
  })
  it('projects only intended visitor fields, without internal fingerprints or provider errors', async () => {
    const result = await listManagedSiteContactMessages(actor, {}, { list: async () => [row()] })
    expect(result.messages[0]?.message).toContain('<script>') // UI escapes text; never render raw HTML.
    expect(result.messages[0]?.deliveryNote).toContain('已保存')
    expect(JSON.stringify(result)).not.toMatch(/private-fingerprint|private-dedupe|provider_rejected|forwardTargetEmail/u)
    expect(result.nextBeforeId).toBeNull()
  })
  it('rejects a wrong-project repository response and invalid pagination', async () => {
    await expect(listManagedSiteContactMessages(actor, {}, { list: async () => [{ ...row(), projectId: 8 }] })).rejects.toMatchObject({ statusCode: 503 })
    const list = vi.fn()
    await expect(listManagedSiteContactMessages(actor, { beforeId: 0 }, { list })).rejects.toMatchObject({ statusCode: 422 })
    expect(list).not.toHaveBeenCalled()
  })
  it('uses bounded keyset pagination and a next cursor without deep offsets', async () => {
    const list = vi.fn(async () => Array.from({ length: 51 }, (_, index) => row(100 - index)))
    const result = await listManagedSiteContactMessages(actor, { beforeId: 101 }, { list })
    expect(list).toHaveBeenCalledWith(actor, 101, 51)
    expect(result.messages).toHaveLength(50)
    expect(result.nextBeforeId).toBe(51)
  })
  it('binds its database query to owner and project, then applies the keyset and limit', async () => {
    const query: any = { innerJoin: vi.fn(() => query), where: vi.fn(() => query), orderBy: vi.fn(() => query), limit: vi.fn(async () => [{ message: row() }]) }
    const database = { select: vi.fn(() => ({ from: vi.fn(() => query) })) }
    const result = await makeContactMessageRepository(database).list(actor, 11, 51)
    expect(query.innerJoin).toHaveBeenCalledOnce()
    expect(query.where).toHaveBeenCalledOnce()
    expect(query.limit).toHaveBeenCalledWith(51)
    expect(result[0]?.projectId).toBe(7)
  })
  it('uses same-project customer authority and escaped text in the page', () => {
    const route = readFileSync(new URL('../server/api/managed-sites/customer/contact-messages.get.ts', import.meta.url), 'utf8')
    const page = readFileSync(new URL('../pages/customer/managed-sites/inbox.vue', import.meta.url), 'utf8')
    expect(route).toContain('requireManagedSiteCustomerPermission')
    expect(route).toContain("'data:export'")
    expect(route).toContain('privateManagedSiteHeaders')
    expect(route).not.toContain('query.projectId')
    expect(page).not.toContain('v-html')
    expect(page).toContain('{{ item.message }}')
  })
})
