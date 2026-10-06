import { createHash } from 'node:crypto'
import { parseFirstPartyContentDocument } from '../first-party-content-site-kit/parser'
import { scanOutcomeLearningPii } from '../outcome-learning/content-learning-runtime'
import { isValidContentRoot, strictTimestamp, utf8ByteLength } from './normalization'
import type { FirstPartyRepositoryChangeKind, FirstPartyRepositoryChangeSet, FirstPartyRepositoryChangeUnit, FirstPartyPublishTarget, FirstPartyArtifact } from './types'

const CHANGE_SET_SCHEMA = 'first-party-repository-change-set-v1' as const
const CHANGE_SET_FINGERPRINT_DOMAIN = 'first-party-repository-change-set-payload-v1' as const
const MAX_CHANGE_UNITS = 512
const MAX_CHANGESET_SOURCE_BYTES = 1_048_576
const SHA256 = /^[a-f0-9]{64}$/
const BLOB_SHA = /^[a-f0-9]{7,64}$/
const COMMIT_SHA = /^[a-f0-9]{40}$/
const CHANGE_KINDS = new Set<FirstPartyRepositoryChangeKind>(['added', 'removed', 'replaced', 'unmodified'])

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseDocument(target: FirstPartyPublishTarget, path: string, markdown: string) {
  if (!isValidContentRoot(target.contentRoot)) return undefined
  const result = parseFirstPartyContentDocument({ contentRoot: target.contentRoot, sourcePath: path, markdown })
  return result.status === 'verified' ? result.document : undefined
}

function identityFingerprint(identity: object): string {
  return hash(JSON.stringify(identity))
}

export function repositoryChangeSetTargetFingerprint(target: Pick<FirstPartyPublishTarget, 'targetId' | 'ownerScopeKey' | 'repositoryOwner' | 'repositoryName' | 'defaultBranch'>, path: string): string {
  return hash(`${CHANGE_SET_FINGERPRINT_DOMAIN}\ntarget\n${JSON.stringify({
    targetId: target.targetId,
    ownerScopeKey: target.ownerScopeKey,
    repositoryOwner: target.repositoryOwner,
    repositoryName: target.repositoryName,
    branch: target.defaultBranch,
    path,
  })}`)
}

function paragraphHashes(body: string): string[] {
  return body.split(/\n[\t ]*\n+/).filter(paragraph => paragraph.trim().length > 0).map(hash)
}

function unit(kind: FirstPartyRepositoryChangeKind, beforeIndex: number | null, afterIndex: number | null, beforeHash: string | null, afterHash: string | null): FirstPartyRepositoryChangeUnit {
  return { kind, beforeIndex, afterIndex, beforeHash, afterHash }
}

function paragraphDiff(before: readonly string[], after: readonly string[]): FirstPartyRepositoryChangeUnit[] | undefined {
  if (before.length + after.length > MAX_CHANGE_UNITS) return undefined
  const width = after.length + 1
  const table = new Uint16Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const position = i * width + j
      table[position] = before[i] === after[j]
        ? 1 + table[(i + 1) * width + j + 1]!
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }

  const result: FirstPartyRepositoryChangeUnit[] = []
  let beforeGap: number[] = [], afterGap: number[] = []
  const flush = () => {
    const replacements = Math.min(beforeGap.length, afterGap.length)
    for (let index = 0; index < replacements; index++) {
      const oldIndex = beforeGap[index]!, newIndex = afterGap[index]!
      result.push(unit('replaced', oldIndex, newIndex, before[oldIndex]!, after[newIndex]!))
    }
    for (const oldIndex of beforeGap.slice(replacements)) result.push(unit('removed', oldIndex, null, before[oldIndex]!, null))
    for (const newIndex of afterGap.slice(replacements)) result.push(unit('added', null, newIndex, null, after[newIndex]!))
    beforeGap = []
    afterGap = []
  }

  let i = 0, j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush()
      result.push(unit('unmodified', i, j, before[i]!, after[j]!))
      i++; j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      beforeGap.push(i++)
    } else {
      afterGap.push(j++)
    }
  }
  while (i < before.length) beforeGap.push(i++)
  while (j < after.length) afterGap.push(j++)
  flush()
  return result.length + 1 <= MAX_CHANGE_UNITS ? result : undefined
}

function changeSetPayload(value: Omit<FirstPartyRepositoryChangeSet, 'changesetFingerprint' | 'changeSetId'>): string {
  return `${CHANGE_SET_FINGERPRINT_DOMAIN}\n${JSON.stringify(value)}`
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return undefined
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined
    }
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
  } catch {
    return undefined
  }
}

function strictArrayItems(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return undefined
    const values: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined
      values.push(descriptor.value)
    }
    return values
  } catch {
    return undefined
  }
}

function exactHashArray(value: unknown): value is readonly string[] {
  const items = strictArrayItems(value, MAX_CHANGE_UNITS)
  return items !== undefined && items.every(item => typeof item === 'string' && SHA256.test(item))
}

function validChangeUnit(value: unknown, title = false): value is FirstPartyRepositoryChangeUnit {
  const record = exactRecord(value, ['kind', 'beforeIndex', 'afterIndex', 'beforeHash', 'afterHash'])
  if (!record || typeof record.kind !== 'string' || !CHANGE_KINDS.has(record.kind as FirstPartyRepositoryChangeKind)) return false
  const beforeIndex = record.beforeIndex, afterIndex = record.afterIndex
  const beforeHash = record.beforeHash, afterHash = record.afterHash
  const validIndex = (index: unknown) => index === null || Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < MAX_CHANGE_UNITS
  const validHash = (item: unknown) => item === null || typeof item === 'string' && SHA256.test(item)
  if (!validIndex(beforeIndex) || !validIndex(afterIndex) || !validHash(beforeHash) || !validHash(afterHash)) return false
  if (title) {
    if (beforeIndex !== null || afterIndex !== null) return false
    if (record.kind === 'added') return beforeHash === null && typeof afterHash === 'string'
    if (record.kind === 'removed') return typeof beforeHash === 'string' && afterHash === null
    if (record.kind === 'replaced') return typeof beforeHash === 'string' && typeof afterHash === 'string'
    return typeof beforeHash === 'string' && beforeHash === afterHash
  }
  if (record.kind === 'added') return beforeIndex === null && beforeHash === null && afterIndex !== null && typeof afterHash === 'string'
  if (record.kind === 'removed') return beforeIndex !== null && typeof beforeHash === 'string' && afterIndex === null && afterHash === null
  if (record.kind === 'replaced') return beforeIndex !== null && typeof beforeHash === 'string' && afterIndex !== null && typeof afterHash === 'string' && beforeHash !== afterHash
  return beforeIndex !== null && typeof beforeHash === 'string' && afterIndex !== null && beforeHash === afterHash && afterHash === beforeHash
}

function validUnitCoverage(units: readonly FirstPartyRepositoryChangeUnit[], before: readonly string[], after: readonly string[]): boolean {
  const oldIndices = new Set<number>(), newIndices = new Set<number>()
  for (const item of units) {
    if (item.beforeIndex !== null) {
      if (oldIndices.has(item.beforeIndex) || before[item.beforeIndex] !== item.beforeHash) return false
      oldIndices.add(item.beforeIndex)
    }
    if (item.afterIndex !== null) {
      if (newIndices.has(item.afterIndex) || after[item.afterIndex] !== item.afterHash) return false
      newIndices.add(item.afterIndex)
    }
  }
  if (oldIndices.size !== before.length || newIndices.size !== after.length) return false
  let lastOld = -1, lastNew = -1
  for (const item of units) {
    if (item.beforeIndex !== null) {
      if (item.beforeIndex <= lastOld) return false
      lastOld = item.beforeIndex
    }
    if (item.afterIndex !== null) {
      if (item.afterIndex <= lastNew) return false
      lastNew = item.afterIndex
    }
  }
  return true
}

export function verifyRepositoryChangeSet(value: unknown): value is FirstPartyRepositoryChangeSet {
  try {
    const record = exactRecord(value, ['schemaVersion', 'comparisonKind', 'liveBeforeState', 'causalEligibility', 'targetIdentityFingerprint', 'before', 'after', 'titleChange', 'paragraphChanges', 'readAt', 'changesetFingerprint', 'changeSetId'])
    if (!record || record.schemaVersion !== CHANGE_SET_SCHEMA || record.comparisonKind !== 'repository_revision_diff' || record.liveBeforeState !== 'unknown' || record.causalEligibility !== false) return false
    if (typeof record.targetIdentityFingerprint !== 'string' || !SHA256.test(record.targetIdentityFingerprint)) return false
    const before = exactRecord(record.before, ['publicationIdentityFingerprint', 'documentFingerprint', 'bodyHash', 'contentHash', 'titleHash', 'paragraphHashes', 'blobSha', 'remoteRevision'])
    const after = exactRecord(record.after, ['publicationIdentityFingerprint', 'documentFingerprint', 'bodyHash', 'contentHash', 'titleHash', 'paragraphHashes', 'artifactFingerprint'])
    if (!before || !after) return false
    for (const item of [before.publicationIdentityFingerprint, before.documentFingerprint, before.bodyHash, before.contentHash, before.titleHash, after.publicationIdentityFingerprint, after.documentFingerprint, after.bodyHash, after.contentHash, after.titleHash, after.artifactFingerprint]) {
      if (typeof item !== 'string' || !SHA256.test(item)) return false
    }
    if (before.bodyHash !== before.contentHash || after.bodyHash !== after.contentHash) return false
    if (typeof before.blobSha !== 'string' || !BLOB_SHA.test(before.blobSha) || before.remoteRevision !== null && (typeof before.remoteRevision !== 'string' || !COMMIT_SHA.test(before.remoteRevision))) return false
    if (!exactHashArray(before.paragraphHashes) || !exactHashArray(after.paragraphHashes) || before.paragraphHashes.length + after.paragraphHashes.length > MAX_CHANGE_UNITS) return false
    const rawUnits = strictArrayItems(record.paragraphChanges, MAX_CHANGE_UNITS - 1)
    const rawTitleChange = record.titleChange
    if (!validChangeUnit(rawTitleChange, true) || !rawUnits) return false
    const titleChange = rawTitleChange
    if (titleChange.beforeHash !== before.titleHash || titleChange.afterHash !== after.titleHash) return false
    if (titleChange.kind !== (before.titleHash === after.titleHash ? 'unmodified' : 'replaced')) return false
    const units: FirstPartyRepositoryChangeUnit[] = []
    for (const item of rawUnits) {
      if (!validChangeUnit(item)) return false
      units.push(item)
    }
    if (!validUnitCoverage(units, before.paragraphHashes, after.paragraphHashes)) return false
    const expectedUnits = paragraphDiff(before.paragraphHashes, after.paragraphHashes)
    if (!expectedUnits || JSON.stringify(expectedUnits) !== JSON.stringify(units)) return false
    const timestamp = strictTimestamp(record.readAt)
    if (!timestamp.ok || timestamp.iso !== record.readAt) return false
    if (typeof record.changesetFingerprint !== 'string' || !SHA256.test(record.changesetFingerprint) || typeof record.changeSetId !== 'string' || !SHA256.test(record.changeSetId)) return false
    const { changesetFingerprint: _fingerprint, changeSetId: _id, ...payload } = record as unknown as FirstPartyRepositoryChangeSet
    const calculatedFingerprint = hash(changeSetPayload(payload))
    const calculatedId = hash(`${CHANGE_SET_SCHEMA}:${calculatedFingerprint}`)
    return calculatedFingerprint === record.changesetFingerprint && calculatedId === record.changeSetId
  } catch {
    return false
  }
}

export function buildRepositoryChangeSet(input: {
  readonly target: FirstPartyPublishTarget
  readonly artifact: FirstPartyArtifact
  readonly beforeMarkdown: string
  readonly blobSha: string
  readonly remoteRevision?: string
  readonly readAt: unknown
}): FirstPartyRepositoryChangeSet | undefined {
  try {
    const timestamp = strictTimestamp(input.readAt)
    if (!timestamp.ok || !isValidContentRoot(input.target.contentRoot) || !/^[a-f0-9]{7,64}$/i.test(input.blobSha)) return undefined
    if (input.remoteRevision !== undefined && !COMMIT_SHA.test(input.remoteRevision)) return undefined
    const before = parseDocument(input.target, input.artifact.path, input.beforeMarkdown)
    const afterMarkdown = input.artifact.frontmatter ? `${input.artifact.frontmatter}\n${input.artifact.body}` : input.artifact.body
    const after = parseDocument(input.target, input.artifact.path, afterMarkdown)
    if (!before || !after || utf8ByteLength(input.beforeMarkdown) > MAX_CHANGESET_SOURCE_BYTES || utf8ByteLength(afterMarkdown) > MAX_CHANGESET_SOURCE_BYTES) return undefined
    if (scanOutcomeLearningPii({ beforeTitle: before.title, beforeBody: before.body, afterTitle: after.title, afterBody: after.body }).status !== 'none_detected') return undefined
    const beforeParagraphHashes = paragraphHashes(before.body)
    const afterParagraphHashes = paragraphHashes(after.body)
    if (beforeParagraphHashes.length + afterParagraphHashes.length > MAX_CHANGE_UNITS) return undefined
    const paragraphChanges = paragraphDiff(beforeParagraphHashes, afterParagraphHashes)
    if (!paragraphChanges) return undefined
    const set: Omit<FirstPartyRepositoryChangeSet, 'changesetFingerprint' | 'changeSetId'> = {
      schemaVersion: CHANGE_SET_SCHEMA,
      comparisonKind: 'repository_revision_diff',
      liveBeforeState: 'unknown',
      causalEligibility: false,
      targetIdentityFingerprint: repositoryChangeSetTargetFingerprint(input.target, input.artifact.path),
      before: {
        publicationIdentityFingerprint: identityFingerprint(before.publicationIdentity),
        documentFingerprint: before.documentFingerprint,
        bodyHash: before.bodyHash,
        contentHash: before.bodyHash,
        titleHash: hash(before.title),
        paragraphHashes: beforeParagraphHashes,
        blobSha: input.blobSha.toLowerCase(),
        remoteRevision: input.remoteRevision ?? null,
      },
      after: {
        publicationIdentityFingerprint: identityFingerprint(after.publicationIdentity),
        documentFingerprint: after.documentFingerprint,
        bodyHash: after.bodyHash,
        contentHash: after.bodyHash,
        titleHash: hash(after.title),
        paragraphHashes: afterParagraphHashes,
        artifactFingerprint: input.artifact.artifactFingerprint,
      },
      titleChange: unit(before.title === after.title ? 'unmodified' : 'replaced', null, null, hash(before.title), hash(after.title)),
      paragraphChanges,
      readAt: timestamp.iso,
    }
    const changesetFingerprint = hash(changeSetPayload(set))
    const result: FirstPartyRepositoryChangeSet = { ...set, changesetFingerprint, changeSetId: hash(`${CHANGE_SET_SCHEMA}:${changesetFingerprint}`) }
    return verifyRepositoryChangeSet(result) ? result : undefined
  } catch {
    return undefined
  }
}
