import type { AdapterResult, ProbeProvider, VisibilityProbeAdapter } from './types'
import { normalizeCitationSourceDate } from '../llm-visibility/citation-freshness'
import { canonicalizePublicHttps } from '../llm-visibility/guards'

const OFFICIAL_ENDPOINTS: Record<ProbeProvider, string> = {
  chatgpt: 'https://api.openai.com/v1/responses',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  perplexity: 'https://api.perplexity.ai/chat/completions',
}

export type VisibilityServerCredentialResolver = (provider: ProbeProvider) => Promise<string | null> | string | null
export type VisibilityServerAdapterConfig = {
  adapterKey: string
  provider: ProbeProvider
  modelLabel: string
  credentialResolver: VisibilityServerCredentialResolver
  fetchImpl?: typeof fetch
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || new TextEncoder().encode(normalized).byteLength > maximum) return null
  return normalized
}

function readCitationUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const direct = [record.citations, record.citation_urls]
    .flatMap(value => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === 'string')
  const grounding = record.groundingMetadata
  const chunks = grounding && typeof grounding === 'object' && Array.isArray((grounding as Record<string, unknown>).groundingChunks) ? (grounding as Record<string, unknown>).groundingChunks as unknown[] : []
  const grounded = chunks.flatMap(chunk => {
    if (!chunk || typeof chunk !== 'object') return []
    const web = (chunk as Record<string, unknown>).web
    const uri = web && typeof web === 'object' ? (web as Record<string, unknown>).uri : undefined
    return typeof uri === 'string' ? [uri] : []
  })
  return [...new Set([...direct, ...grounded])].slice(0, 50)
}

function readCitationDates(provider: ProbeProvider, payload: unknown, citationUrls: string[]): Record<string, string> | undefined {
  if (provider !== 'perplexity' || !payload || typeof payload !== 'object') return undefined
  const allowed = new Set<string>()
  for (const citationUrl of citationUrls) {
    try { allowed.add(canonicalizePublicHttps(citationUrl).url) } catch { /* Strict response normalization will reject the invalid citation itself. */ }
  }
  const searchResults = Array.isArray((payload as Record<string, unknown>).search_results) ? (payload as Record<string, unknown>).search_results as unknown[] : []
  const dates: Record<string, string> = {}
  for (const result of searchResults) {
    if (Object.keys(dates).length >= 50) break
    if (!result || typeof result !== 'object') continue
    const rawUrl = (result as Record<string, unknown>).url
    const rawDate = (result as Record<string, unknown>).date
    if (typeof rawUrl !== 'string' || typeof rawDate !== 'string') continue
    let canonicalUrl: string
    try { canonicalUrl = canonicalizePublicHttps(rawUrl).url } catch { continue }
    if (!allowed.has(canonicalUrl) || dates[canonicalUrl] !== undefined) continue
    const sourceDate = normalizeCitationSourceDate(rawDate)
    if (sourceDate === null) continue
    dates[canonicalUrl] = sourceDate
  }
  return Object.keys(dates).length ? dates : undefined
}

function readResponseText(provider: ProbeProvider, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (provider === 'gemini') {
    const candidates = Array.isArray(record.candidates) ? record.candidates : []
    const parts = candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return []
      const content = (candidate as Record<string, unknown>).content
      const candidateParts = content && typeof content === 'object' ? (content as Record<string, unknown>).parts : undefined
      return Array.isArray(candidateParts) ? candidateParts : []
    })
    const text = parts.map(part => part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined).filter((value): value is string => typeof value === 'string').join('\n')
    return boundedText(text, 120_000)
  }
  if (provider === 'chatgpt') {
    const output = Array.isArray(record.output) ? record.output : []
    const outputText = output.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const content = (item as Record<string, unknown>).content
      return Array.isArray(content) ? content : []
    }).map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).text : undefined).filter((value): value is string => typeof value === 'string').join('\n')
    if (outputText) return boundedText(outputText, 120_000)
  }
  const choices = Array.isArray(record.choices) ? record.choices : []
  const first = choices[0]
  if (first && typeof first === 'object') {
    const message = (first as Record<string, unknown>).message
    const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : undefined
    if (typeof content === 'string') return boundedText(content, 120_000)
  }
  return null
}

function responseFailure(status: number): AdapterResult {
  const retryable = status === 408 || status === 429 || status >= 500
  return { ok: false, failureKind: 'http_error', retryable, code: `HTTP_${status}`, httpStatus: status }
}

function endpointFor(provider: ProbeProvider, modelLabel: string): string {
  if (provider === 'gemini') return `${OFFICIAL_ENDPOINTS[provider]}/${encodeURIComponent(modelLabel)}:generateContent`
  return OFFICIAL_ENDPOINTS[provider]
}

function requestFor(provider: ProbeProvider, modelLabel: string, prompt: string) {
  if (provider === 'gemini') return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'text/plain' } }
  if (provider === 'chatgpt') return { model: modelLabel, input: prompt, stream: false }
  return { model: modelLabel, messages: [{ role: 'user', content: prompt }], stream: false }
}

function headersFor(provider: ProbeProvider, credential: string): Record<string, string> {
  if (provider === 'gemini') return { 'content-type': 'application/json', 'x-goog-api-key': credential }
  return { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }
}

export function createVisibilityProviderAdapter(config: VisibilityServerAdapterConfig): VisibilityProbeAdapter {
  const fetchImpl = config.fetchImpl || fetch
  return {
    adapterKey: config.adapterKey,
    provider: config.provider,
    modelLabel: config.modelLabel,
    async execute(input) {
      const credential = await config.credentialResolver(config.provider)
      if (!credential || credential.trim().length < 8) return { ok: false, failureKind: 'invalid_input', retryable: false, code: 'CREDENTIAL_NOT_CONFIGURED' }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
      try {
        const response = await fetchImpl(endpointFor(config.provider, config.modelLabel), { method: 'POST', headers: headersFor(config.provider, credential), body: JSON.stringify(requestFor(config.provider, config.modelLabel, input.normalizedPrompt)), signal: input.abortSignal || controller.signal, redirect: 'error' })
        if (!response.ok) return responseFailure(response.status)
        const contentLength = response.headers.get('content-length')
        if (contentLength && Number(contentLength) > 120_000) return { ok: false, failureKind: 'response_too_large', retryable: false, code: 'RESPONSE_TOO_LARGE' }
        const payload = await response.json()
        const responseText = readResponseText(config.provider, payload)
        if (!responseText) return { ok: false, failureKind: 'malformed_response', retryable: false, code: 'RESPONSE_TEXT_MISSING' }
        const providerRequestId = response.headers.get('x-request-id') || (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).id === 'string' ? (payload as Record<string, unknown>).id as string : undefined)
        const citationUrls = readCitationUrls(payload)
        const citationDates = readCitationDates(config.provider, payload, citationUrls)
        return { ok: true, provider: config.provider, modelLabel: config.modelLabel, responseText, citationUrls, observedAt: new Date().toISOString(), ...(providerRequestId ? { providerRequestId: providerRequestId.slice(0, 256) } : {}), ...(citationDates ? { citationDates } : {}) }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return { ok: false, failureKind: 'timeout', retryable: true, code: 'PROVIDER_TIMEOUT' }
        return { ok: false, failureKind: 'network_unavailable', retryable: true, code: 'PROVIDER_NETWORK_UNAVAILABLE' }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

export function createEnvironmentVisibilityCredentialResolver(environment: Record<string, string | undefined> = process.env): VisibilityServerCredentialResolver {
  return provider => environment[provider === 'chatgpt' ? 'OPENAI_API_KEY' : provider === 'gemini' ? 'GEMINI_API_KEY' : 'PERPLEXITY_API_KEY'] || null
}

export function createConfiguredVisibilityProviderAdapters(configs: readonly Omit<VisibilityServerAdapterConfig, 'credentialResolver'>[] = [], environment?: Record<string, string | undefined>): Record<string, VisibilityProbeAdapter> {
  const credentialResolver = createEnvironmentVisibilityCredentialResolver(environment)
  return Object.fromEntries(configs.map(config => [config.adapterKey, createVisibilityProviderAdapter({ ...config, credentialResolver })]))
}
