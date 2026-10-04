import { createHash, createHmac } from 'node:crypto'
import type { FirstPartyAdapterInput } from './types'
import { SIGNED_API_ENDPOINT_PATH } from './target-guard'

export const SIGNED_API_V2_VERSION = 'first-party-signed-api-v2' as const

/** The exact bytes and destination are authenticated; the receiver recomputes all identity hashes. */
export function buildSignedApiV2Signature(rawBody: string, targetOrigin: string, secret: string, timestamp: string, nonce: string): string {
  const payloadHash = createHash('sha256').update(rawBody, 'utf8').digest('hex')
  return createHmac('sha256', secret).update([SIGNED_API_V2_VERSION, 'POST', SIGNED_API_ENDPOINT_PATH, targetOrigin, payloadHash, timestamp, nonce].join('\n'), 'utf8').digest('hex')
}

export function buildSignedApiV2Body(input: FirstPartyAdapterInput, timestamp: string, nonce: string): string {
  const p = input.publication
  return JSON.stringify({
    commandVersion: input.command.commandVersion,
    signatureVersion: SIGNED_API_V2_VERSION,
    targetId: input.target.targetId,
    publicationId: p.productionDeliverableId,
    idempotencyKey: input.command.idempotencyKey,
    contentHash: p.contentHash,
    evidenceSnapshotHash: p.evidenceSnapshotHash,
    artifactFingerprint: input.artifact.artifactFingerprint,
    path: input.artifact.path,
    framework: input.target.framework,
    content: `${input.artifact.frontmatter}\n${input.artifact.body}`,
    timestamp, nonce,
    identity: input.artifact.publicationIdentity,
    publication: {
      title: p.title, body: p.body, slug: p.slug, contentType: p.contentType, language: p.language,
      scheduledAt: p.scheduledAt, authoritySourceIds: p.authoritySourceIds, ruleIds: p.ruleIds,
      draftStage: p.draftStage, reviewDecision: p.reviewDecision, riskGateStatus: p.riskGateStatus,
    },
  })
}
