export type OpenAiCompatibleProviderLabel = 'bailian' | 'openai'

export const OPENAI_COMPATIBLE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

const WORKSPACE_BAILIAN_HOST_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,62}\.)?(?:cn-beijing|ap-southeast-1|ap-northeast-1|cn-hongkong|eu-central-1)\.maas\.aliyuncs\.com$/
const BAILIAN_HOSTS = new Set(['dashscope-intl.aliyuncs.com', 'dashscope.aliyuncs.com'])
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 200_000

export type OpenAiCompatibleProviderConfiguration =
  | { configured: true; endpoint: string; model: string; apiKey: string; providerLabel: OpenAiCompatibleProviderLabel; source: 'llm' | 'legacy-geoflow-qwen' | 'legacy-autogeo-bailian' }
  | { configured: false; reason: 'endpoint-missing' | 'endpoint-not-allowed' | 'api-key-missing' | 'model-missing' | 'model-invalid' }

export type OpenAiCompatibleProviderErrorCode = 'configuration' | 'timeout' | 'transport' | 'unauthorized' | 'rate_limited' | 'upstream' | 'malformed_response'

export class OpenAiCompatibleProviderError extends Error {
  constructor(readonly code: OpenAiCompatibleProviderErrorCode, readonly retryable: boolean = code === 'timeout' || code === 'transport' || code === 'rate_limited', readonly httpStatus: number | null = null) {
    super(`OpenAI-compatible provider error: ${code}${httpStatus === null ? '' : ` (HTTP ${httpStatus})`}`)
    this.name = 'OpenAiCompatibleProviderError'
  }
}

export interface OpenAiCompatibleChatClient {
  readonly endpoint: string
  readonly model: string
  readonly providerLabel: OpenAiCompatibleProviderLabel
  complete(input: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    responseFormat?: 'text' | 'json_object'
    reasoning?: 'default' | 'disabled'
    timeoutMs?: number
    requestId?: string
    maxResponseBytes?: number
  }): Promise<{
    content: string
    model: string
    providerLabel: OpenAiCompatibleProviderLabel
    usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
    finishReason: string | null
  }>
}

function providerLabelForHost(hostname: string): OpenAiCompatibleProviderLabel | null {
  if (hostname === 'api.openai.com') return 'openai'
  if (BAILIAN_HOSTS.has(hostname) || WORKSPACE_BAILIAN_HOST_PATTERN.test(hostname)) return 'bailian'
  return null
}

export function normalizeOpenAiCompatibleEndpoint(value: string): string | null {
  try {
    const trimmed = value.trim()
    const authority = /^https:\/\/([^/?#]+)/iu.exec(trimmed)?.[1]
    const authorityHost = authority?.split('@').at(-1)
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || !authorityHost || authorityHost.includes(':') || trimmed.includes('?') || trimmed.includes('#') || url.username || url.password || url.search || url.hash || url.port) return null
    const hostname = url.hostname.toLowerCase()
    const label = providerLabelForHost(hostname)
    if (!label) return null
    const basePath = label === 'bailian' ? '/compatible-mode/v1' : '/v1'
    const fullPath = `${basePath}/chat/completions`
    const normalizedPath = url.pathname.endsWith('/') && url.pathname !== '/' ? url.pathname.slice(0, -1) : url.pathname
    if (normalizedPath !== basePath && normalizedPath !== fullPath) return null
    return `https://${hostname}${fullPath}`
  } catch { return null }
}

export function isAllowedOpenAiCompatibleEndpoint(value: string): boolean {
  return normalizeOpenAiCompatibleEndpoint(value) !== null
}

export function openAiCompatibleProviderLabel(endpoint: string): OpenAiCompatibleProviderLabel | null {
  const normalized = normalizeOpenAiCompatibleEndpoint(endpoint)
  if (!normalized) return null
  return providerLabelForHost(new URL(normalized).hostname.toLowerCase())
}

function runtimeConfiguration(): Record<string, unknown> {
  try { return useRuntimeConfig() as Record<string, unknown> } catch { return {} }
}

function configuredValue(env: Record<string, string | undefined>, runtimeConfig: Record<string, unknown>, envName: string, runtimeName: string): string {
  const environmentValue = String(env[envName] || '').trim()
  return environmentValue || String(runtimeConfig[runtimeName] || '').trim()
}

export function resolveOpenAiCompatibleProviderConfiguration(input: { env?: Record<string, string | undefined>; runtimeConfig?: Record<string, unknown>; modelOverride?: string } = {}): OpenAiCompatibleProviderConfiguration {
  const env = input.env || process.env
  const runtimeConfig = input.runtimeConfig || runtimeConfiguration()
  const endpointCandidates = [
    { value: configuredValue(env, runtimeConfig, 'NUXT_LLM_ENDPOINT', 'llmEndpoint'), source: 'llm' as const },
    { value: configuredValue(env, runtimeConfig, 'NUXT_GEOFLOW_QWEN_ENDPOINT', 'geoflowQwenEndpoint'), source: 'legacy-geoflow-qwen' as const },
    { value: configuredValue(env, runtimeConfig, 'NUXT_AUTOGEO_BAILIAN_ENDPOINT', 'autoGeoBailianEndpoint'), source: 'legacy-autogeo-bailian' as const },
  ]
  const selectedEndpoint = endpointCandidates.find(candidate => candidate.value)
  if (!selectedEndpoint) return { configured: false, reason: 'endpoint-missing' }
  const endpoint = normalizeOpenAiCompatibleEndpoint(selectedEndpoint.value)
  if (!endpoint) return { configured: false, reason: 'endpoint-not-allowed' }
  const providerLabel = openAiCompatibleProviderLabel(endpoint)!

  const apiKey = configuredValue(env, runtimeConfig, 'NUXT_LLM_API_KEY', 'llmApiKey')
    || configuredValue(env, runtimeConfig, 'NUXT_GEOFLOW_QWEN_API_KEY', 'geoflowQwenApiKey')
    || configuredValue(env, runtimeConfig, 'NUXT_AUTOGEO_BAILIAN_API_KEY', 'autoGeoBailianApiKey')
  if (!apiKey) return { configured: false, reason: 'api-key-missing' }

  const explicitModel = String(input.modelOverride || '').trim() || configuredValue(env, runtimeConfig, 'NUXT_LLM_MODEL', 'llmModel')
  const model = explicitModel || (providerLabel === 'bailian'
    ? configuredValue(env, runtimeConfig, 'NUXT_GEOFLOW_QWEN_MODEL', 'geoflowQwenModel') || configuredValue(env, runtimeConfig, 'NUXT_AUTOGEO_BAILIAN_MODEL', 'autoGeoBailianModel') || 'qwen-plus'
    : '')
  if (!model) return { configured: false, reason: 'model-missing' }
  if (!OPENAI_COMPATIBLE_MODEL_PATTERN.test(model)) return { configured: false, reason: 'model-invalid' }
  return { configured: true, endpoint, model, apiKey, providerLabel, source: selectedEndpoint.source }
}

function numericToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new OpenAiCompatibleProviderError('malformed_response', false)
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new OpenAiCompatibleProviderError('malformed_response', false)
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally { reader.releaseLock() }
}

export function createOpenAiCompatibleChatClient(options: { endpoint: string; apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number }): OpenAiCompatibleChatClient {
  const endpoint = normalizeOpenAiCompatibleEndpoint(options.endpoint)
  const apiKey = options.apiKey.trim()
  const model = options.model.trim()
  const providerLabel = endpoint ? openAiCompatibleProviderLabel(endpoint) : null
  if (!endpoint || !providerLabel || !apiKey || !OPENAI_COMPATIBLE_MODEL_PATTERN.test(model)) throw new OpenAiCompatibleProviderError('configuration', false)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const defaultMaxResponseBytes = Number.isSafeInteger(options.maxResponseBytes) && Number(options.maxResponseBytes) > 0 ? Number(options.maxResponseBytes) : DEFAULT_MAX_RESPONSE_BYTES

  return {
    endpoint,
    model,
    providerLabel,
    async complete(input) {
      const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : defaultTimeoutMs
      const maxResponseBytes = Number.isSafeInteger(input.maxResponseBytes) && Number(input.maxResponseBytes) > 0 ? Number(input.maxResponseBytes) : defaultMaxResponseBytes
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...(input.requestId ? { 'x-discoverystack-request-id': input.requestId } : {}),
          },
          body: JSON.stringify({ model, stream: false, messages: input.messages, ...(input.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}), ...(input.reasoning === 'disabled' ? { enable_thinking: false } : {}) }),
        })
      } catch (error) {
        const aborted = controller.signal.aborted || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
        throw new OpenAiCompatibleProviderError(aborted ? 'timeout' : 'transport', true)
      } finally { clearTimeout(timer) }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new OpenAiCompatibleProviderError('unauthorized', false, response.status)
        if (response.status === 429) throw new OpenAiCompatibleProviderError('rate_limited', true, response.status)
        if (response.status === 408 || response.status >= 500) throw new OpenAiCompatibleProviderError('upstream', true, response.status)
        throw new OpenAiCompatibleProviderError('upstream', false, response.status)
      }

      let payload: any
      try { payload = JSON.parse(await readBoundedResponse(response, maxResponseBytes)) } catch (error) {
        if (error instanceof OpenAiCompatibleProviderError) throw error
        throw new OpenAiCompatibleProviderError('malformed_response', false)
      }
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) throw new OpenAiCompatibleProviderError('malformed_response', false)
      return {
        content,
        model: typeof payload.model === 'string' && OPENAI_COMPATIBLE_MODEL_PATTERN.test(payload.model) ? payload.model : model,
        providerLabel,
        usage: { inputTokens: numericToken(payload?.usage?.prompt_tokens), outputTokens: numericToken(payload?.usage?.completion_tokens), totalTokens: numericToken(payload?.usage?.total_tokens) },
        finishReason: typeof payload?.choices?.[0]?.finish_reason === 'string' ? payload.choices[0].finish_reason : null,
      }
    },
  }
}
