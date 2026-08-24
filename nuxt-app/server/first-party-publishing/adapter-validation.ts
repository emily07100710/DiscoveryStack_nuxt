import { planFirstPartyPublication } from './command'
import { canonicalJson, isRecord, normalizeApprovedPublication, readValue, strictTimestamp } from './normalization'
import { validateFirstPartyPublishTarget } from './target-guard'
import type { ApprovedFirstPartyPublication, FirstPartyArtifact, FirstPartyBlockedResult, FirstPartyPublishCommand, FirstPartyTransport, ValidatedFirstPartyTarget } from './types'

export type FirstPartyAdapterBindingResult =
  | {
      readonly status: 'valid'
      readonly target: ValidatedFirstPartyTarget
      readonly publication: ApprovedFirstPartyPublication
      readonly artifact: FirstPartyArtifact
      readonly command: FirstPartyPublishCommand
      readonly now: string
    }
  | FirstPartyBlockedResult

function blocked(code: FirstPartyBlockedResult['code'], ...reasons: string[]): FirstPartyBlockedResult {
  return { status: 'blocked', code, reasons }
}

export function validateFirstPartyAdapterBindings(input: unknown, expectedTransport: FirstPartyTransport): FirstPartyAdapterBindingResult {
  try {
    if (!isRecord(input)) return blocked('INVALID_INPUT', 'adapter input must be a plain object')
    const targetResult = validateFirstPartyPublishTarget(readValue(input, 'target'))
    if (targetResult.status === 'blocked') return targetResult
    if (targetResult.target.transport !== expectedTransport) return blocked('UNSUPPORTED_ROUTE', 'adapter transport does not match the approved target')
    const publicationResult = normalizeApprovedPublication(readValue(input, 'publication'))
    if (!publicationResult.ok) return blocked('PUBLICATION_NOT_APPROVED', publicationResult.reason)
    const now = strictTimestamp(readValue(input, 'now'))
    if (!now.ok) return blocked('INVALID_TIMESTAMP', now.reason)
    const planned = planFirstPartyPublication(targetResult.target, publicationResult.publication, now.iso)
    if (planned.status === 'blocked') return planned
    const suppliedCommand = canonicalJson(readValue(input, 'command'))
    const suppliedArtifact = canonicalJson(readValue(input, 'artifact'))
    const plannedCommand = canonicalJson(planned.command)
    const plannedArtifact = canonicalJson(planned.artifact)
    if (!suppliedCommand || !plannedCommand || suppliedCommand !== plannedCommand) return blocked('IDEMPOTENCY_INVALID', 'adapter command does not match the canonical publication plan')
    if (!suppliedArtifact || !plannedArtifact || suppliedArtifact !== plannedArtifact) return blocked('ARTIFACT_FINGERPRINT_INVALID', 'adapter artifact does not match the canonical publication plan')
    return {
      status: 'valid',
      target: targetResult.target,
      publication: publicationResult.publication,
      artifact: planned.artifact,
      command: planned.command,
      now: now.iso,
    }
  } catch {
    return blocked('INVALID_INPUT', 'adapter bindings could not be safely validated')
  }
}
