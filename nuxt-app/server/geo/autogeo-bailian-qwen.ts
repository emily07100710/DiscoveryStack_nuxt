import { randomUUID } from 'node:crypto'
import { AUTOGEO_UPSTREAM, buildOfficialAutoGeoPrompt } from './autogeo-api'
import type { GeoDocumentInput, GeoRewriteAdapter, GeoRewriteCandidate } from './contracts'
import { assertSourceBoundRewrite } from './output-safety'

const BAILIAN_ENDPOINT_PATH = '/compatible-mode/v1/chat/completions'
const DEFAULT_BAILIAN_MODEL = 'qwen-plus'
const DEFAULT_TIMEOUT_MS = 30_000
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const WORKSPACE_BAILIAN_HOST_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,62}\.)?(?:cn-beijing|ap-southeast-1|ap-northeast-1|cn-hongkong|eu-central-1)\.maas\.aliyuncs\.com$/
const LEGACY_BAILIAN_HOSTS = new Set(['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com'])
type FetchLike = (input: string, init: RequestInit) => Promise<Response>
type BailianResponse = { model?: string, choices?: Array<{ message?: { content?: string } }>, usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } }
type BailianConfigurationIssue = 'missing-credential' | 'missing-endpoint' | 'invalid-endpoint' | 'invalid-model'
type BailianProviderIssue = 'timeout' | 'transport' | 'upstream' | 'malformed-response'

export class AutoGeoBailianConfigurationError extends Error {
  constructor(readonly issue: BailianConfigurationIssue) { super('The AutoGEO Bailian Qwen adapter configuration is unavailable or invalid.'); this.name = 'AutoGeoBailianConfigurationError' }
}
export class AutoGeoBailianProviderError extends Error {
  constructor(readonly issue: BailianProviderIssue, readonly httpStatus?: number) { super('The AutoGEO Bailian Qwen provider did not return a usable rewrite.'); this.name = 'AutoGeoBailianProviderError' }
}
export type AutoGeoBailianQwenAdapterOptions = { apiKey?: string, endpoint?: string, model?: string, timeoutMs?: number, fetchImpl?: FetchLike, requestIdFactory?: () => string }
type BailianRuntimeConfiguration = { apiKey: string, endpoint: string, model: string }

function serverRuntimeConfiguration(): BailianRuntimeConfiguration {
  const environment = { apiKey: String(process.env.NUXT_AUTOGEO_BAILIAN_API_KEY || '').trim(), endpoint: String(process.env.NUXT_AUTOGEO_BAILIAN_ENDPOINT || '').trim(), model: String(process.env.NUXT_AUTOGEO_BAILIAN_MODEL || '').trim() }
  try {
    const runtime = useRuntimeConfig()
    return { apiKey: String(runtime.autoGeoBailianApiKey || environment.apiKey).trim(), endpoint: String(runtime.autoGeoBailianEndpoint || environment.endpoint).trim(), model: String(runtime.autoGeoBailianModel || environment.model || DEFAULT_BAILIAN_MODEL).trim() }
  } catch { return { ...environment, model: environment.model || DEFAULT_BAILIAN_MODEL } }
}

export function isAllowedBailianEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (WORKSPACE_BAILIAN_HOST_PATTERN.test(url.hostname) || LEGACY_BAILIAN_HOSTS.has(url.hostname)) && url.pathname === BAILIAN_ENDPOINT_PATH && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

function resolveConfiguration(options: AutoGeoBailianQwenAdapterOptions): BailianRuntimeConfiguration {
  const runtime = serverRuntimeConfiguration()
  const configuration = { apiKey: options.apiKey?.trim() || runtime.apiKey, endpoint: options.endpoint?.trim() || runtime.endpoint, model: options.model?.trim() || runtime.model }
  if (!configuration.apiKey) throw new AutoGeoBailianConfigurationError('missing-credential')
  if (!configuration.endpoint) throw new AutoGeoBailianConfigurationError('missing-endpoint')
  if (!isAllowedBailianEndpoint(configuration.endpoint)) throw new AutoGeoBailianConfigurationError('invalid-endpoint')
  if (!MODEL_ID_PATTERN.test(configuration.model)) throw new AutoGeoBailianConfigurationError('invalid-model')
  return configuration
}
function responseContent(payload: BailianResponse): string { const content = payload.choices?.[0]?.message?.content?.trim(); if (!content) throw new AutoGeoBailianProviderError('malformed-response'); return content }
function nonSensitiveUsage(usage: BailianResponse['usage']) {
  if (!usage) return undefined
  const inputTokens = usage.prompt_tokens; const outputTokens = usage.completion_tokens; const totalTokens = usage.total_tokens
  return [inputTokens, outputTokens, totalTokens].some(value => typeof value === 'number' && Number.isFinite(value)) ? { inputTokens, outputTokens, totalTokens } : undefined
}

export function createAutoGeoBailianQwenAdapter(options: AutoGeoBailianQwenAdapterOptions = {}): GeoRewriteAdapter {
  const configuration = resolveConfiguration(options)
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Math.min(Math.max(options.timeoutMs || DEFAULT_TIMEOUT_MS, 1_000), 60_000)
  const requestIdFactory = options.requestIdFactory || randomUUID
  return {
    id: 'autogeo-bailian-qwen', version: `autogeo-framework-bailian-qwen@${AUTOGEO_UPSTREAM.revision.slice(0, 12)}+${configuration.model}`,
    async rewrite(document, rules) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const providerRequestId = requestIdFactory(); let response: Response
      try {
        response = await fetchImpl(configuration.endpoint, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.apiKey}`, 'x-discoverystack-request-id': providerRequestId }, body: JSON.stringify({ model: configuration.model, stream: false, messages: [{ role: 'user', content: buildOfficialAutoGeoPrompt(document, rules) }] }) })
      } catch { throw new AutoGeoBailianProviderError(controller.signal.aborted ? 'timeout' : 'transport') } finally { clearTimeout(timer) }
      if (!response.ok) throw new AutoGeoBailianProviderError('upstream', response.status)
      let payload: BailianResponse
      try { payload = await response.json() as BailianResponse } catch { throw new AutoGeoBailianProviderError('malformed-response') }
      const actualModel = typeof payload.model === 'string' && MODEL_ID_PATTERN.test(payload.model) ? payload.model : configuration.model
      const optimizedContent = responseContent(payload)
      assertSourceBoundRewrite(document, document.title, optimizedContent)
      return {
        provider: 'autogeo-bailian-qwen', providerVersion: `autogeo-framework-bailian-qwen@${AUTOGEO_UPSTREAM.revision.slice(0, 12)}+${actualModel}`, optimizedTitle: document.title, optimizedContent, appliedRuleIds: rules.map(rule => rule.id),
        safetyNotes: ['本次內容以 AutoGEO 官方 prompt／Researchy-GEO ruleset，透過設定的百煉 Qwen API 產生；這不是 AutoGEO Mini，也不是 upstream Gemini execution。', '輸出是草稿；發布前仍須由內容 owner 查核事實、引用、時效性、商標與法規主張。', 'Workbench 不會將原文寫入資料庫或用於訓練；原文僅會在本次 request 中傳送至設定的百煉 provider。'],
        provenance: { requestedProvider: 'autogeo-bailian-qwen', execution: 'autogeo-framework-bailian-qwen', upstreamRepository: AUTOGEO_UPSTREAM.repository, upstreamRevision: AUTOGEO_UPSTREAM.revision, rewriteMethod: AUTOGEO_UPSTREAM.rewriteMethod, ruleset: AUTOGEO_UPSTREAM.ruleset, model: actualModel, usage: nonSensitiveUsage(payload.usage) },
      } satisfies GeoRewriteCandidate
    },
  }
}
