import { executeGitContentsPublish } from './git-adapter'
import { normalizeApprovedPublication, strictTimestamp } from './normalization'
import { planFirstPartyPublication } from './command'
import { validateFirstPartyPublishTarget } from './target-guard'
import { executeSignedApiPublish } from './signed-api-adapter'
import { FIRST_PARTY_EXECUTOR_VERSION, type FirstPartyAdapterResult, type FirstPartyBlockedResult, type FirstPartyExecutionContext, type FirstPartyExecutionResult, type FirstPartyFailureResult, type FirstPartyRequestPreview, type FirstPartyAdapterInput, type ValidatedFirstPartyTarget } from './types'

function blocked(code: FirstPartyBlockedResult['code'], ...reasons: string[]): FirstPartyBlockedResult {
  return { status: 'blocked', code, reasons }
}

function preview(target: ValidatedFirstPartyTarget, artifactBytes: number, path: string, branch: string): FirstPartyRequestPreview {
  const git = target.transport === 'first_party_git'
  return {
    mode: 'dry_run',
    method: git ? 'PUT' : 'POST',
    url: git ? `${target.targetOrigin}/repos/${target.repositoryOwner}/${target.repositoryName}/contents/${path}` : `${target.targetOrigin}${target.endpointPath ?? ''}`,
    targetOrigin: target.targetOrigin,
    path,
    branch,
    bodyBytes: artifactBytes,
    bodyIncluded: false,
    headerNames: git ? ['accept', 'content-type'] : ['content-type', 'x-discoverystack-version', 'x-discoverystack-publication-id', 'x-discoverystack-idempotency-key', 'x-discoverystack-timestamp', 'x-discoverystack-nonce', 'x-discoverystack-signature'],
    includesAuthorization: false,
    includesSecret: false,
    redirect: 'manual',
  }
}

function retryable(code: FirstPartyFailureResult['code']): boolean {
  return code === 'REMOTE_RATE_LIMITED' || code === 'REMOTE_SERVER_ERROR' || code === 'NETWORK_FAILURE' || code === 'TIMEOUT'
}

function mapAdapterResult(result: FirstPartyAdapterResult, command: FirstPartyAdapterInput['command']): FirstPartyExecutionResult {
  if (result.status === 'blocked') return result
  if (result.status === 'failure') {
    const status = retryable(result.code) ? 'retryable_failure' : 'permanent_failure'
    return { status, code: result.code, reasons: result.reasons, ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }) }
  }
  return {
    status: 'delivered',
    remoteState: result.remoteState,
    publicationId: result.remote.publicationId,
    contentHash: result.remote.contentHash,
    remoteRevision: result.remote.remoteRevision,
    ...(result.remote.repositoryOwner === undefined ? {} : { repositoryOwner: result.remote.repositoryOwner }),
    ...(result.remote.repositoryName === undefined ? {} : { repositoryName: result.remote.repositoryName }),
    ...(result.remote.branch === undefined ? {} : { branch: result.remote.branch }),
    ...(result.remote.path === undefined ? {} : { path: result.remote.path }),
    artifactFingerprint: command.artifactFingerprint,
    idempotencyKey: command.idempotencyKey,
  }
}

export async function executeFirstPartyPublication(context: FirstPartyExecutionContext): Promise<FirstPartyExecutionResult> {
  try {
    const plan = planFirstPartyPublication(context.target, context.publication, context.now)
    if (plan.status === 'blocked') return plan
    const targetResult = validateFirstPartyPublishTarget(context.target)
    const publicationResult = normalizeApprovedPublication(context.publication)
    const now = strictTimestamp(context.now)
    const serverNow = strictTimestamp(context.serverNow ?? context.now)
    if (targetResult.status === 'blocked' || !publicationResult.ok || !now.ok || !serverNow.ok) return blocked('INVALID_TIMESTAMP', 'validated execution timestamps were not stable')
    const target = targetResult.target
    const publication = publicationResult.publication
    if (context.mode === 'dry_run') return { status: 'dry_run', preview: preview(target, plan.artifact.bytes, plan.artifact.path, target.defaultBranch) }
    if (context.mode !== 'execute') return blocked('INVALID_INPUT', 'execution mode is invalid')
    if (target.status !== 'active') return blocked('TARGET_NOT_ACTIVE', 'target is not active')
    if (!target.executionEnabled) return blocked('EXECUTION_DISABLED', 'target execution is disabled')
    if (typeof context.fetchImpl !== 'function') return blocked('EXECUTOR_NOT_CONFIGURED', 'fetch implementation is required')
    if (typeof context.serverCredentialResolver !== 'function') return blocked('CREDENTIAL_MISSING', 'server credential resolver is required')
    if (target.transport === 'first_party_signed_api' && typeof context.nonceProvider !== 'function') return blocked('NONCE_INVALID', 'signed API execution requires an injected nonce provider')
    const adapterInput: FirstPartyAdapterInput = {
      target,
      publication,
      artifact: plan.artifact,
      command: plan.command,
      now: now.iso,
      fetchImpl: context.fetchImpl,
    }
    if (target.transport === 'first_party_git') {
      const gitResult = await executeGitContentsPublish(adapterInput, { fetchImpl: context.fetchImpl, serverCredentialResolver: context.serverCredentialResolver })
      return mapAdapterResult(gitResult, adapterInput.command)
    }
    const signedResult = await executeSignedApiPublish(adapterInput, { fetchImpl: context.fetchImpl, serverCredentialResolver: context.serverCredentialResolver, nonceProvider: context.nonceProvider as NonNullable<typeof context.nonceProvider>, serverNowProvider: () => serverNow.iso })
    return mapAdapterResult(signedResult, adapterInput.command)
  } catch {
    return blocked('INVALID_INPUT', 'first-party execution input could not be safely read')
  }
}

export { FIRST_PARTY_EXECUTOR_VERSION }
