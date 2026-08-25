import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { executeMultiChannelFanout, executeMultiChannelPublication, createMultiChannelExecutorRegistry } from '../server/publication-routing/multi-channel-executors'
import { makePlan, LEGAL_TARGETS, FIXTURE_CONTENT, FIXTURE_NOW } from './fixtures/publication-routing/fixtures'

const plan = makePlan([LEGAL_TARGETS.wordpress])
const route = plan.routes[0]!
const baseInput = {
  plan,
  routeId: route.routeId,
  content: FIXTURE_CONTENT,
  idempotencyKey: 'dispatch-key-1',
  executorRunId: 'ref-run-1',
  attempt: 1,
  now: FIXTURE_NOW + 100,
  mode: 'execute' as const,
}

describe('publication multi-channel executors', () => {
  it('dispatches WordPress through an injected transport and accepts only matching identity', async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify({ publicationId: route.destinationPublicationIdentity, contentHash: route.contentHash, remoteRevision: 'wp-revision-1' }) })
    const registry = createMultiChannelExecutorRegistry({ httpTransport: transport })
    const result = await executeMultiChannelPublication({ ...baseInput, registry, resolveCredential: async ref => ref === route.credentialReference ? 'fake-placeholder-secret' : undefined })
    expect(result.status).toBe('delivered')
    expect(result.receipt?.status).toBe('delivered')
    expect(result.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('fake-placeholder-secret')
    const payload = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
    expect(payload.content).toBe(FIXTURE_CONTENT)
    expect(transport.mock.calls[0]?.[1]?.headers.authorization).toBe('Bearer fake-placeholder-secret')
  })

  it('blocks before resolving credential for an SSRF or special-use target', () => {
    expect(() => makePlan([{ ...LEGAL_TARGETS.wordpress, targetUrl: 'https://wordpress.example/wp-json' }])).toThrow(/SPECIAL_USE|special-use|target/i)
  })

  it('blocks a missing executor or credential with a validated receipt and no transport call', async () => {
    const missingExecutor = await executeMultiChannelPublication({ ...baseInput, registry: {}, resolveCredential: vi.fn() })
    expect(missingExecutor.status).toBe('blocked')
    expect(missingExecutor.receipt?.status).toBe('blocked')
    const missingCredential = await executeMultiChannelPublication({ ...baseInput, registry: createMultiChannelExecutorRegistry({ httpTransport: vi.fn() }), resolveCredential: async () => undefined, executorRunId: 'ref-run-2' })
    expect(missingCredential.status).toBe('blocked')
    expect(missingCredential.receipt?.status).toBe('blocked')
  })

  it('blocks remote identity mismatch and never returns delivered', async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify({ publicationId: 'wrong-publication', contentHash: route.contentHash, remoteRevision: 'revision' }) })
    const result = await executeMultiChannelPublication({ ...baseInput, registry: createMultiChannelExecutorRegistry({ httpTransport: transport }), resolveCredential: async () => 'fake-placeholder-secret' })
    expect(result.status).toBe('blocked')
    expect(result.receipt?.status).toBe('blocked')
  })

  it('maps rate limits and server errors to retry_wait receipts', async () => {
    const transport = vi.fn().mockResolvedValue({ status: 429, text: async () => '' })
    const result = await executeMultiChannelPublication({ ...baseInput, registry: createMultiChannelExecutorRegistry({ httpTransport: transport }), resolveCredential: async () => 'fake-placeholder-secret' })
    expect(result.status).toBe('retry_wait')
    expect(result.receipt?.status).toBe('retry_wait')
  })

  it('replays an existing receipt without a second executor call', async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify({ publicationId: route.destinationPublicationIdentity, contentHash: route.contentHash, remoteRevision: 'revision' }) })
    const first = await executeMultiChannelPublication({ ...baseInput, registry: createMultiChannelExecutorRegistry({ httpTransport: transport }), resolveCredential: async () => 'fake-placeholder-secret' })
    expect(first.receipt).not.toBeNull()
    const second = await executeMultiChannelPublication({ ...baseInput, knownReceipts: [first.receipt!], registry: createMultiChannelExecutorRegistry({ httpTransport: transport }), resolveCredential: async () => 'fake-placeholder-secret' })
    expect(second.replay).toBe(true)
    expect(second.status).toBe('delivered')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('fans out across channels and reports partial failure truthfully', async () => {
    const multiPlan = makePlan([LEGAL_TARGETS.wordpress, LEGAL_TARGETS.phpAgent])
    const calls: string[] = []
    const registry = createMultiChannelExecutorRegistry({ httpTransport: async (_url, init) => {
      const payload = JSON.parse(init.body)
      calls.push(payload.routeId)
      return { status: payload.transport === 'geoflow_agent' ? 503 : 200, text: async () => JSON.stringify({ publicationId: payload.destinationPublicationIdentity, contentHash: multiPlan.routes.find(candidate => candidate.routeId === payload.routeId)?.contentHash, remoteRevision: 'revision' }) }
    } })
    const result = await executeMultiChannelFanout({ plan: multiPlan, routeIds: multiPlan.routes.map(candidate => candidate.routeId), content: FIXTURE_CONTENT, idempotencyKey: 'fanout-key', executorRunIdPrefix: 'fanout-run', attempt: 1, now: FIXTURE_NOW + 100, mode: 'execute', registry, resolveCredential: async () => 'fake-placeholder-secret' })
    expect(result.status).toBe('partial_failure')
    expect(result.results.map(item => item.status)).toEqual(expect.arrayContaining(['delivered', 'retry_wait']))
    expect(result.receipts).toHaveLength(2)
    expect(calls).toHaveLength(2)
  })

  it('keeps geoflow_local on an injected local transport without requiring a public URL', async () => {
    const localPlan = makePlan([LEGAL_TARGETS.geoflowLocal])
    const localRoute = localPlan.routes[0]!
    const localTransport = vi.fn().mockResolvedValue({ status: 'delivered', remote: { publicationId: localRoute.destinationPublicationIdentity, contentHash: localRoute.contentHash, remoteRevision: 'local-revision' } })
    const result = await executeMultiChannelPublication({ ...baseInput, plan: localPlan, routeId: localRoute.routeId, registry: { geoflow_local: localTransport }, resolveCredential: async () => 'fake-placeholder-secret' })
    expect(result.status).toBe('delivered')
    expect(localTransport).toHaveBeenCalledTimes(1)
  })

  it('uses exact approved content bytes for hash validation', async () => {
    const transport = vi.fn()
    const wrongContent = `${FIXTURE_CONTENT}\n`
    const result = await executeMultiChannelPublication({ ...baseInput, content: wrongContent, registry: createMultiChannelExecutorRegistry({ httpTransport: transport }), resolveCredential: async () => 'fake-placeholder-secret' })
    expect(result.status).toBe('blocked')
    expect(result.reasons.join(' ')).toContain('content hash')
    expect(transport).not.toHaveBeenCalled()
    expect(createHash('sha256').update(FIXTURE_CONTENT).digest('hex')).toBe(route.contentHash)
  })
})
