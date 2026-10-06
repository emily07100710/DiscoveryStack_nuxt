import { createHash } from 'node:crypto'
import { fingerprint } from '../geo-outcome-model/canonical'
import { repositoryChangeSetTargetFingerprint, verifyRepositoryChangeSet } from '../first-party-publishing/change-set'
import type { FirstPartyPublishTarget } from '../first-party-publishing/types'

export type PublicationActionIdentity = {
  ownerUserId: number; entryId: number; draftId: number; draftVersion: number
  draftContentHash: string; evidenceSnapshotHash: string; targetId: number
  receiptFingerprint: string; publicationContentHash: string; artifactFingerprint: string
}
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** A diff checksum is accepted only inside the exact server-owned delivered publication identity. */
export function bindPublicationRepositoryChangeSet(input: {
  identity: PublicationActionIdentity
  target: Pick<FirstPartyPublishTarget, 'targetId' | 'ownerScopeKey' | 'repositoryOwner' | 'repositoryName' | 'defaultBranch'>
  path: string; title: string; body: string; changeSet: unknown
}) {
  try {
    const { identity, changeSet } = input
    if (!verifyRepositoryChangeSet(changeSet) || [identity.ownerUserId, identity.entryId, identity.draftId, identity.draftVersion, identity.targetId].some(id => !Number.isSafeInteger(id) || id <= 0) || [identity.draftContentHash, identity.evidenceSnapshotHash, identity.receiptFingerprint, identity.publicationContentHash, identity.artifactFingerprint].some(hash => !/^[a-f0-9]{64}$/.test(hash))) return null
    if (sha(`${input.title}\n${input.body}`) !== identity.draftContentHash || sha(input.body) !== identity.publicationContentHash || changeSet.after.bodyHash !== identity.publicationContentHash || changeSet.after.artifactFingerprint !== identity.artifactFingerprint || changeSet.after.titleHash !== sha(input.title) || changeSet.targetIdentityFingerprint !== repositoryChangeSetTargetFingerprint(input.target, input.path)) return null
    const identityFingerprint = fingerprint({ contract: 'content-publication-action-identity-v1', ...identity })
    const body = { contractVersion: 'content-publication-action-binding-v1' as const, identityFingerprint, changesetFingerprint: changeSet.changesetFingerprint, changeSet }
    return { ...body, bindingFingerprint: fingerprint(body) }
  } catch { return null }
}

export type PublicationActionBinding = NonNullable<ReturnType<typeof bindPublicationRepositoryChangeSet>>
