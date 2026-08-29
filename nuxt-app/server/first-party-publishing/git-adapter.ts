import { GITHUB_CONTENTS_ORIGIN, type FirstPartyAdapterInput, type FirstPartyAdapterResult, type FirstPartyDecisionCode, type GitAdapterDependencies } from './types'
import { isValidBranch, isValidRepositoryPart, readValue } from './normalization'
import { validateFirstPartyAdapterBindings } from './adapter-validation'

const DEFAULT_TIMEOUT_MS = 15_000
const GITHUB_API_VERSION = '2026-03-10'
const SHA_PATTERN = /^[a-f0-9]{7,64}$/i
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i

function blocked(code: FirstPartyDecisionCode, ...reasons: string[]): FirstPartyAdapterResult {
  return { status: 'blocked', code, reasons }
}

function failure(code: FirstPartyDecisionCode, reasons: string[], httpStatus?: number): FirstPartyAdapterResult {
  return { status: 'failure', code, reasons, ...(httpStatus === undefined ? {} : { httpStatus }) }
}

function isSafeStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
}

function encodedPath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function contentsBaseUrl(input: FirstPartyAdapterInput): string {
  const owner = input.target.repositoryOwner as string
  const name = input.target.repositoryName as string
  return `${GITHUB_CONTENTS_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath(input.artifact.path)}`
}

function contentsReadUrl(input: FirstPartyAdapterInput): string {
  return `${contentsBaseUrl(input)}?ref=${encodeURIComponent(input.target.defaultBranch)}`
}

function authHeaders(credential: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': GITHUB_API_VERSION,
    authorization: `Bearer ${credential}`,
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function repositoryEchoMatches(value: unknown, owner: string, name: string): boolean {
  if (value === undefined) return true
  if (typeof value === 'string') return value === `${owner}/${name}`
  const record = readObject(value)
  if (!record) return false
  const ownerField = readValue(record, 'owner')
  const ownerRecord = readObject(ownerField)
  const responseOwner = typeof ownerField === 'string' ? ownerField : ownerRecord ? readValue(ownerRecord, 'login') : readValue(record, 'login')
  const responseName = readValue(record, 'name')
  return responseOwner === owner && responseName === name
}

function responseIdentityValid(value: unknown, input: FirstPartyAdapterInput): boolean {
  const record = readObject(value)
  if (!record) return false
  const owner = input.target.repositoryOwner
  const name = input.target.repositoryName
  if (owner === null || name === null) return false
  const repository = readValue(record, 'repository')
  const branch = readValue(record, 'branch')
  const content = readObject(readValue(record, 'content'))
  const responseUrl = readValue(record, 'url') ?? (content ? readValue(content, 'url') : undefined)
  if (!repositoryEchoMatches(repository, owner, name)) return false
  if (repository === undefined && responseUrl !== contentsBaseUrl(input)) return false
  if (branch !== undefined && branch !== input.target.defaultBranch) return false
  const path = readValue(record, 'path') ?? (content ? readValue(content, 'path') : undefined)
  return path === input.artifact.path
}

async function safeJson(response: { text: () => Promise<string> }): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await response.text()
    const parsed: unknown = JSON.parse(raw)
    return readObject(parsed)
  } catch {
    return undefined
  }
}

function decodeContent(value: unknown): string | undefined {
  const record = readObject(value)
  if (!record) return undefined
  const nested = readObject(readValue(record, 'content'))
  const encoded = nested ? readValue(nested, 'content') : readValue(record, 'content')
  const encoding = nested ? readValue(nested, 'encoding') : readValue(record, 'encoding')
  if (typeof encoded !== 'string' || encoding !== 'base64') return undefined
  try {
    const compact = encoded.replace(/\s/g, '')
    if (compact.length < 4 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined
    const bytes = Buffer.from(compact, 'base64')
    if (bytes.toString('base64') !== compact) return undefined
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return decoded.length > 0 ? decoded : undefined
  } catch {
    return undefined
  }
}

type RemoteFrontmatterIdentity =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'present'; readonly publicationId: string; readonly contentHash: string }

function remoteFrontmatterIdentity(decoded: string): RemoteFrontmatterIdentity {
  if (!decoded.startsWith('---\n')) return { status: 'absent' }
  const closing = decoded.indexOf('\n---\n', 4)
  if (closing < 0) return { status: 'invalid' }
  let publicationId: string | undefined
  let contentHash: string | undefined
  for (const line of decoded.slice(4, closing).split('\n')) {
    const separator = line.indexOf(': ')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    if (key !== 'publicationId' && key !== 'contentHash') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(separator + 2))
    } catch {
      return { status: 'invalid' }
    }
    if (typeof parsed !== 'string') return { status: 'invalid' }
    if (key === 'publicationId') {
      if (publicationId !== undefined) return { status: 'invalid' }
      publicationId = parsed
    } else {
      if (contentHash !== undefined) return { status: 'invalid' }
      contentHash = parsed
    }
  }
  if (publicationId === undefined && contentHash === undefined) return { status: 'absent' }
  if (publicationId === undefined || contentHash === undefined) return { status: 'invalid' }
  return { status: 'present', publicationId, contentHash }
}

function buildPutBody(input: FirstPartyAdapterInput, existingSha: string | undefined): string {
  const artifactBytes = input.artifact.frontmatter ? `${input.artifact.frontmatter}\n${input.artifact.body}` : input.artifact.body
  const payload = {
    message: input.command.commitMessage,
    content: Buffer.from(artifactBytes, 'utf8').toString('base64'),
    branch: input.target.defaultBranch,
    ...(existingSha === undefined ? {} : { sha: existingSha }),
  }
  return JSON.stringify(payload)
}

function resultFromRemote(input: FirstPartyAdapterInput, remote: Record<string, unknown>, remoteState: 'created' | 'updated'): FirstPartyAdapterResult {
  if (!responseIdentityValid(remote, input)) return blocked('RESPONSE_INVALID', 'GitHub response repository, path, or branch does not match the approved target')
  const content = readObject(readValue(remote, 'content'))
  const commit = readObject(readValue(remote, 'commit'))
  const blobSha = content ? readValue(content, 'sha') : undefined
  const commitSha = commit ? readValue(commit, 'sha') : undefined
  if (typeof blobSha !== 'string' || !SHA_PATTERN.test(blobSha) || typeof commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(commitSha)) return blocked('RESPONSE_INVALID', 'GitHub response is missing a valid blob SHA or commit SHA')
  return {
    status: 'ok',
    remoteState,
    remote: {
      publicationId: input.publication.productionDeliverableId,
      contentHash: input.publication.contentHash,
      remoteRevision: commitSha,
      repositoryOwner: input.target.repositoryOwner as string,
      repositoryName: input.target.repositoryName as string,
      branch: input.target.defaultBranch,
      path: input.artifact.path,
      blobSha,
      commitSha,
    },
  }
}

function statusFailure(status: number): FirstPartyAdapterResult {
  if (status === 401 || status === 403) return failure('REMOTE_UNAUTHORIZED', ['GitHub rejected the server credential or policy'], status)
  if (status === 409 || status === 422) return failure('REMOTE_CONFLICT', ['GitHub rejected the write as a conflict or validation error'], status)
  if (status === 429) return failure('REMOTE_RATE_LIMITED', ['GitHub rate limited the request'], status)
  if (status >= 500 && status <= 599) return failure('REMOTE_SERVER_ERROR', ['GitHub returned a server failure'], status)
  if (status >= 400 && status <= 499) return failure('REMOTE_CONFLICT', ['GitHub rejected the request'], status)
  if (status >= 300 && status <= 399) return blocked('REDIRECT_BLOCKED', 'GitHub returned a redirect, which is never followed')
  return failure('RESPONSE_INVALID', ['GitHub returned an unexpected status'], status)
}

export async function executeGitContentsPublish(input: FirstPartyAdapterInput, dependencies: GitAdapterDependencies): Promise<FirstPartyAdapterResult> {
  try {
    const bindings = validateFirstPartyAdapterBindings(input, 'first_party_git')
    if (bindings.status === 'blocked') return bindings
    input = { ...input, target: bindings.target, publication: bindings.publication, artifact: bindings.artifact, command: bindings.command, now: bindings.now, fetchImpl: dependencies.fetchImpl }
    if (!input.target.executionEnabled) return blocked('EXECUTION_DISABLED', 'target execution is disabled')
    if (input.target.transport !== 'first_party_git' || input.target.targetOrigin !== GITHUB_CONTENTS_ORIGIN) return blocked('UNSUPPORTED_ROUTE', 'Git adapter requires the exact GitHub Contents origin')
    if (input.target.repositoryOwner === null || input.target.repositoryName === null || !isValidRepositoryPart(input.target.repositoryOwner) || !isValidRepositoryPart(input.target.repositoryName) || !isValidBranch(input.target.defaultBranch)) return blocked('INVALID_REPOSITORY', 'Git repository or branch is not valid')
    if (typeof dependencies.serverCredentialResolver !== 'function') return blocked('CREDENTIAL_MISSING', 'server credential resolver is required')
    if (typeof dependencies.fetchImpl !== 'function') return blocked('EXECUTOR_NOT_CONFIGURED', 'fetch implementation is required')
    const resolved = await dependencies.serverCredentialResolver(input.target.credentialReference)
    if (!resolved.ok || typeof resolved.value !== 'string' || resolved.value.length < 1 || resolved.value.length > 4_096 || /[\u0000-\u001f\u007f-\u009f]/.test(resolved.value)) return blocked('CREDENTIAL_MISSING', 'server credential could not be resolved')
    const credential = resolved.value
    const readUrl = contentsReadUrl(input)
    const writeUrl = contentsBaseUrl(input)
    const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return blocked('INVALID_INPUT', 'timeoutMs is outside the bounded policy')
    const getResponse = await dependencies.fetchImpl(readUrl, { method: 'GET', headers: authHeaders(credential), redirect: 'manual', timeoutMs })
    if (!isSafeStatus(getResponse.status)) return blocked('RESPONSE_INVALID', 'GitHub GET response status is invalid')
    if (getResponse.status === 404) {
      const putResponse = await dependencies.fetchImpl(writeUrl, { method: 'PUT', headers: authHeaders(credential), body: buildPutBody(input, undefined), redirect: 'manual', timeoutMs })
      if (!isSafeStatus(putResponse.status)) return blocked('RESPONSE_INVALID', 'GitHub PUT response status is invalid')
      if (putResponse.status < 200 || putResponse.status > 299) return statusFailure(putResponse.status)
      const putBody = await safeJson(putResponse)
      if (!putBody) return blocked('RESPONSE_INVALID', 'GitHub PUT response is not valid JSON')
      return resultFromRemote(input, putBody, 'created')
    }
    if (getResponse.status < 200 || getResponse.status > 299) return statusFailure(getResponse.status)
    const existing = await safeJson(getResponse)
    const existingContent = decodeContent(existing)
    if (!existing || !responseIdentityValid({ ...existing, path: readValue(existing, 'path') }, input) || existingContent === undefined) return blocked('RESPONSE_INVALID', 'GitHub GET response is missing canonical file identity or content')
    const existingContentRecord = readObject(readValue(existing, 'content'))
    const existingSha = existingContentRecord ? readValue(existingContentRecord, 'sha') : readValue(existing, 'sha')
    if (typeof existingSha !== 'string' || !SHA_PATTERN.test(existingSha)) return blocked('RESPONSE_INVALID', 'GitHub GET response is missing a valid blob SHA')
    const remoteIdentity = remoteFrontmatterIdentity(existingContent)
    if (remoteIdentity.status === 'invalid') return blocked('REMOTE_IDENTITY_COLLISION', 'remote publication frontmatter identity is malformed or ambiguous')
    const expectedArtifact = input.artifact.frontmatter ? `${input.artifact.frontmatter}\n${input.artifact.body}` : input.artifact.body
    if (existingContent === expectedArtifact) {
      return {
        status: 'ok',
        remoteState: 'idempotent_replay',
        remote: {
          publicationId: input.publication.productionDeliverableId,
          contentHash: input.publication.contentHash,
          remoteRevision: existingSha,
          repositoryOwner: input.target.repositoryOwner,
          repositoryName: input.target.repositoryName,
          branch: input.target.defaultBranch,
          path: input.artifact.path,
          blobSha: existingSha,
        },
      }
    }
    if (remoteIdentity.status === 'present' && remoteIdentity.publicationId === input.publication.productionDeliverableId && remoteIdentity.contentHash === input.publication.contentHash && existingContent === expectedArtifact) {
      return {
        status: 'ok',
        remoteState: 'idempotent_replay',
        remote: {
          publicationId: input.publication.productionDeliverableId,
          contentHash: input.publication.contentHash,
          remoteRevision: existingSha,
          repositoryOwner: input.target.repositoryOwner,
          repositoryName: input.target.repositoryName,
          branch: input.target.defaultBranch,
          path: input.artifact.path,
          blobSha: existingSha,
        },
      }
    }
    if (remoteIdentity.status === 'present' && remoteIdentity.publicationId === input.publication.productionDeliverableId) return blocked('REMOTE_IDENTITY_COLLISION', 'remote publicationId exists with a different contentHash')
    const putResponse = await dependencies.fetchImpl(writeUrl, { method: 'PUT', headers: authHeaders(credential), body: buildPutBody(input, existingSha), redirect: 'manual', timeoutMs })
    if (!isSafeStatus(putResponse.status)) return blocked('RESPONSE_INVALID', 'GitHub PUT response status is invalid')
    if (putResponse.status < 200 || putResponse.status > 299) return statusFailure(putResponse.status)
    const putBody = await safeJson(putResponse)
    if (!putBody) return blocked('RESPONSE_INVALID', 'GitHub PUT response is not valid JSON')
    return resultFromRemote(input, putBody, 'updated')
  } catch (error) {
    if (error instanceof Error && /timeout|abort/i.test(error.message)) return failure('TIMEOUT', ['GitHub request timed out'])
    return failure('NETWORK_FAILURE', ['GitHub request failed before a trusted response was received'])
  }
}
