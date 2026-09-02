import { sha256Hex } from '../site-evidence/normalization'
import { snippetMatches } from './normalization'
import type { Intervention } from './types'

export function evaluateDeploymentFetch(intervention: Intervention, body: string) {
  const contentHash = sha256Hex(body)
  const snippetChecked = Boolean(intervention.expectedSnippet)
  const snippetFound = intervention.expectedSnippet ? snippetMatches(body, intervention.expectedSnippet) : false
  const changed = Boolean(intervention.baselineContentHash && intervention.baselineContentHash !== contentHash)
  return { contentHash, snippetChecked, snippetFound, changed }
}

export function safeDependencyError(error: unknown) {
  const candidate = error as { code?: unknown, data?: { code?: unknown } }
  const code = typeof candidate?.data?.code === 'string' ? candidate.data.code : typeof candidate?.code === 'string' ? candidate.code : 'provider_failure'
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/gu, ' ').slice(0, 300) : 'Provider check failed.'
  return { code: code.slice(0, 120), message }
}
