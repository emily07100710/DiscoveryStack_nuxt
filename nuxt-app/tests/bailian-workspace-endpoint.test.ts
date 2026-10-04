import { describe, expect, it, vi } from 'vitest'
import { isAllowedBailianEndpoint } from '../server/geo/autogeo-bailian-qwen'
import { normalizeOpenAiCompatibleEndpoint } from '../server/llm-provider/openai-compatible'
import { assertCanonicalBailianManagedSiteEndpoint, resolveManagedSiteProviderVerifier } from '../server/managed-sites/live-connectors/provider-verifiers'

const basePath = '/compatible-mode/v1'
const fullPath = `${basePath}/chat/completions`
const workspace = 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com'
const officialRegions = ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'cn-hongkong', 'eu-central-1', 'us-east-1']

describe('official Bailian workspace endpoint boundary', () => {
  it.each(officialRegions)('allows one exact workspace label in official region %s', region => {
    const origin = `https://ws-abc123.${region}.maas.aliyuncs.com`
    expect(normalizeOpenAiCompatibleEndpoint(`${origin}${basePath}`)).toBe(`${origin}${fullPath}`)
    expect(normalizeOpenAiCompatibleEndpoint(`${origin}${fullPath}`)).toBe(`${origin}${fullPath}`)
    expect(isAllowedBailianEndpoint(`${origin}${fullPath}`)).toBe(true)
  })

  it('retains each adapter\'s exact legacy host contract and DNS label size bound', () => {
    for (const hostname of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com']) {
      expect(normalizeOpenAiCompatibleEndpoint(`https://${hostname}${basePath}`)).toBe(`https://${hostname}${fullPath}`)
      expect(isAllowedBailianEndpoint(`https://${hostname}${fullPath}`)).toBe(true)
    }
    for (const hostname of ['dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com']) {
      expect(normalizeOpenAiCompatibleEndpoint(`https://${hostname}${basePath}`)).toBeNull()
      expect(isAllowedBailianEndpoint(`https://${hostname}${fullPath}`)).toBe(true)
    }
    const maximumLabel = `https://ws-${'a'.repeat(60)}.ap-southeast-1.maas.aliyuncs.com${fullPath}`
    expect(normalizeOpenAiCompatibleEndpoint(maximumLabel)).toBe(maximumLabel)
    expect(isAllowedBailianEndpoint(maximumLabel)).toBe(true)
    expect(normalizeOpenAiCompatibleEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
    expect(isAllowedBailianEndpoint('https://api.openai.com/v1/chat/completions')).toBe(false)
  })

  it.each([
    `http://ws-abc123.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-abc123.ap-southeast-1.maas.aliyuncs.com.attacker.test${fullPath}`,
    `https://workspace.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://extra.ws-abc123.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-abc-123.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-abc_123.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-${'a'.repeat(61)}.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-abc123.us-west-1.maas.aliyuncs.com${fullPath}`,
    `https://ws-abc123.ap-southeast-1.maas.aliyuncs.com:443${fullPath}`,
    `https://ws-abc123.ap-southeast-1.maas.aliyuncs.com:8443${fullPath}`,
    `https://user:password@ws-abc123.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `https://@ws-abc123.ap-southeast-1.maas.aliyuncs.com${fullPath}`,
    `${workspace}${fullPath}?`, `${workspace}${fullPath}?key=synthetic-value`,
    `${workspace}${fullPath}#`, `${workspace}${fullPath}#fragment`,
    `${workspace}/v1/chat/completions`, `${workspace}${basePath}/models`,
    `${workspace}/other/../compatible-mode/v1/chat/completions`,
    `${workspace}/compatible-mode/v1/./chat/completions`,
    `${workspace}/compatible-mode/v1/%63hat/completions`,
    `${workspace}//compatible-mode/v1/chat/completions`,
    `${workspace}${fullPath}\\`,
  ])('rejects noncanonical host or path %s in both adapters', endpoint => {
    expect(normalizeOpenAiCompatibleEndpoint(endpoint)).toBeNull()
    expect(isAllowedBailianEndpoint(endpoint)).toBe(false)
    expect(() => assertCanonicalBailianManagedSiteEndpoint(endpoint)).toThrow()
  })

  it('keeps the legacy AutoGEO full-path requirement while the shared adapter normalizes base paths', () => {
    expect(isAllowedBailianEndpoint(`${workspace}${basePath}`)).toBe(false)
    expect(isAllowedBailianEndpoint(`${workspace}${fullPath}/`)).toBe(false)
    expect(normalizeOpenAiCompatibleEndpoint(`${workspace}${basePath}/`)).toBe(`${workspace}${fullPath}`)
  })
})

describe('mock-only Managed Site model capability probe endpoint', () => {
  const verifier = resolveManagedSiteProviderVerifier('bailian-qwen', 'website_generator')

  it.each([basePath, `${basePath}/`, fullPath, `${fullPath}/`])('posts only the normalized chat-completions path from %s', async path => {
    const endpointOrigin = `${workspace}${path}`
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      id: 'mock-probe-request-001', object: 'chat.completion', created: 1787788800, model: 'qwen-plus',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    }), { status: 200, headers: { 'x-request-id': 'mock-probe-request-001' } }))
    const receipt = await verifier({ capability: 'website_generator', providerKey: 'bailian-qwen', configurationFingerprint: 'a'.repeat(64), transportConfiguration: { endpointOrigin, model: 'qwen-plus' }, credentialReference: 'vault:mock-qwen', resolveCredential: async () => ({ ok: true, value: 'mock-only-credential' }), fetchImpl: fetchImpl as typeof fetch, clock: () => new Date('2026-08-27T00:00:00.000Z') })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(`${workspace}${fullPath}`, expect.objectContaining({ method: 'POST', redirect: 'error' }))
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body))).toMatchObject({ model: 'qwen-plus', stream: false, temperature: 0, max_tokens: 4 })
    expect(receipt).toMatchObject({ providerEventId: 'mock-probe-request-001', capabilityIdentity: 'model-access:qwen-plus' })
    expect(JSON.stringify(receipt)).not.toContain('mock-only-credential')
    expect(JSON.stringify(receipt)).not.toContain('"OK"')
  })

  it('rejects another path before resolving any credential or making a request', async () => {
    const resolveCredential = vi.fn(async () => ({ ok: true as const, value: 'mock-only-credential' }))
    const fetchImpl = vi.fn()
    await expect(verifier({ capability: 'website_generator', providerKey: 'bailian-qwen', configurationFingerprint: 'a'.repeat(64), transportConfiguration: { endpointOrigin: `${workspace}${basePath}/models`, model: 'qwen-plus' }, credentialReference: 'vault:mock-qwen', resolveCredential, fetchImpl, clock: () => new Date('2026-08-27T00:00:00.000Z') })).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Bailian endpoint is outside the canonical official allowlist.' })
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
