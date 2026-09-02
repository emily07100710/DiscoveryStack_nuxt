import { randomUUID } from 'node:crypto'
import { AUTOGEO_UPSTREAM, buildOfficialAutoGeoPrompt } from './autogeo-api'
import type { GeoDocumentInput, GeoRewriteAdapter, GeoRewriteCandidate } from './contracts'
import { assertSourceBoundRewrite } from './output-safety'
import { OpenAiCompatibleProviderError, type OpenAiCompatibleChatClient } from '../llm-provider/openai-compatible'

type AutoGeoOpenAiCompatibleProviderIssue = 'timeout' | 'transport' | 'upstream' | 'malformed-response'

export class AutoGeoOpenAiCompatibleProviderError extends Error {
  constructor(readonly issue: AutoGeoOpenAiCompatibleProviderIssue, readonly httpStatus?: number) {
    super('The AutoGEO OpenAI-compatible provider did not return a usable rewrite.')
    this.name = 'AutoGeoOpenAiCompatibleProviderError'
  }
}

function mappedIssue(error: OpenAiCompatibleProviderError): AutoGeoOpenAiCompatibleProviderIssue {
  if (error.code === 'timeout') return 'timeout'
  if (error.code === 'transport') return 'transport'
  if (error.code === 'malformed_response') return 'malformed-response'
  return 'upstream'
}

function nonSensitiveUsage(usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }) {
  const normalized = {
    inputTokens: usage.inputTokens ?? undefined,
    outputTokens: usage.outputTokens ?? undefined,
    totalTokens: usage.totalTokens ?? undefined,
  }
  return Object.values(normalized).some(value => value !== undefined) ? normalized : undefined
}

export function createAutoGeoOpenAiCompatibleAdapter(options: { client: OpenAiCompatibleChatClient; timeoutMs?: number }): GeoRewriteAdapter {
  return {
    id: 'autogeo-openai-compatible',
    version: 'autogeo-openai-compatible-v1',
    async rewrite(document, rules) {
      let completed: Awaited<ReturnType<OpenAiCompatibleChatClient['complete']>>
      try {
        completed = await options.client.complete({ messages: [{ role: 'user', content: buildOfficialAutoGeoPrompt(document, rules) }], responseFormat: 'text', timeoutMs: options.timeoutMs, requestId: randomUUID() })
      } catch (error) {
        if (error instanceof OpenAiCompatibleProviderError) throw new AutoGeoOpenAiCompatibleProviderError(mappedIssue(error), error.httpStatus ?? undefined)
        throw new AutoGeoOpenAiCompatibleProviderError('transport')
      }
      const optimizedContent = completed.content.trim()
      assertSourceBoundRewrite(document, document.title, optimizedContent)
      return {
        provider: 'autogeo-openai-compatible',
        providerVersion: `autogeo-openai-compatible-v1+${completed.model}`,
        optimizedTitle: document.title,
        optimizedContent,
        appliedRuleIds: rules.map(rule => rule.id),
        safetyNotes: [
          '本次內容以 AutoGEO 官方 prompt／Researchy-GEO ruleset，透過設定的 OpenAI-compatible API 產生；這不是 AutoGEO Mini，也不是 upstream Gemini execution。',
          '輸出是草稿；發布前仍須由內容 owner 查核事實、引用、時效性、商標與法規主張。',
          'Workbench 不會將原文寫入資料庫或用於訓練；原文僅會在本次 request 中傳送至設定的 provider。',
        ],
        provenance: {
          requestedProvider: 'autogeo-openai-compatible',
          execution: 'autogeo-framework-openai-compatible',
          providerExecution: true,
          upstreamRepository: AUTOGEO_UPSTREAM.repository,
          upstreamRevision: AUTOGEO_UPSTREAM.revision,
          rewriteMethod: AUTOGEO_UPSTREAM.rewriteMethod,
          ruleset: AUTOGEO_UPSTREAM.ruleset,
          model: completed.model,
          usage: nonSensitiveUsage(completed.usage),
          providerLabel: completed.providerLabel,
        },
      } satisfies GeoRewriteCandidate
    },
  }
}
