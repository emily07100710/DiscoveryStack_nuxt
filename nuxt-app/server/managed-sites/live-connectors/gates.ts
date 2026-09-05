import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { managedSiteStableFingerprint } from './canonical'
import type { ManagedSiteGateResult } from '../../database/schema'
import { admitManagedSiteGenerationOutput, computeManagedSiteProviderManifestHash } from './generation-artifact'
import { blueprintCompilerFingerprint, compileManagedSiteBlueprint } from './blueprint'
import { getManagedSiteLiveConnectorRepository } from './repository'
import type { ManagedSiteBlueprintV1, ManagedSiteLiveConnectorRepository } from './types'

export const REQUIRED_PREVIEW_GATES = ['artifact_admission', 'deterministic_compiler', 'preview_build', 'security_static_active_content', 'geo_content_structure'] as const

function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function gateFingerprint(value: unknown): string { return stableFingerprint({ schemaVersion: 'managed-site-gate-result-v1', value }) }

async function appendGate(repository: ManagedSiteLiveConnectorRepository, base: { ownerUserId: number; projectId: number; versionId: number; generationCandidateId: number; releaseId: number; contentHash: string; observedAt: Date }, gateType: ManagedSiteGateResult['gateType'], result: ManagedSiteGateResult['result'], inputFingerprint: string, reasonCodes: string[], limitations: string[]) {
  const receiptFingerprint = gateFingerprint({ ...base, gateType, result, inputFingerprint, reasonCodes, limitations })
  return repository.insertGateResult({ ...base, gateType, result, inputFingerprint, reasonCodes, limitations, receiptFingerprint } as any)
}

export async function runManagedSitePreviewGates(ownerUserId: number, releaseId: number, previewReceiptFingerprint: string, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), clock: () => Date = () => new Date()) {
  const release = await repository.findRelease(ownerUserId, releaseId)
  const candidate = release?.generationCandidateId ? await repository.findGenerationCandidate(ownerUserId, release.generationCandidateId) : null
  const preview = await repository.findReceiptByFingerprint(ownerUserId, previewReceiptFingerprint)
  if (!release || !candidate || candidate.projectId !== release.projectId || candidate.sourceVersionId !== release.versionId || candidate.contentHash !== release.contentHash || !preview || preview.releaseId !== release.id || preview.receiptType !== 'preview_build_verified' || preview.receiptStatus !== 'verified' || preview.contentHash !== release.contentHash) conflict('Preview gates require exact candidate, release, content hash, and verified preview build receipt.')
  const manifest = candidate.manifest as Record<string, unknown>
  const blueprint = manifest.blueprint as ManagedSiteBlueprintV1
  if (!blueprint || blueprint.schemaVersion !== 'managed-site-blueprint-v1') conflict('Immutable candidate does not contain an admitted structured blueprint.')
  const files = compileManagedSiteBlueprint(blueprint)
  const compilerFingerprint = blueprintCompilerFingerprint(blueprint, files)
  const admitted = admitManagedSiteGenerationOutput({ schemaVersion: 'managed-site-generation-provider-response-v1', providerKey: candidate.providerKey, providerModel: candidate.providerModel, providerRequestId: candidate.providerRequestId, requestFingerprint: candidate.requestFingerprint, files, manifestHash: computeManagedSiteProviderManifestHash(files) }, { requestFingerprint: candidate.requestFingerprint, providerKey: candidate.providerKey })
  if (admitted.manifest.contentHash !== candidate.contentHash || manifest.compilerFingerprint !== compilerFingerprint || manifest.blueprintHash !== managedSiteStableFingerprint(blueprint)) conflict('Recompiled candidate does not match immutable compiler or content authority.')
  const observedAt = clock()
  const base = { ownerUserId, projectId: release.projectId, versionId: release.versionId, generationCandidateId: candidate.id, releaseId: release.id, contentHash: release.contentHash, observedAt }
  const common = gateFingerprint({ candidateId: candidate.id, releaseId: release.id, contentHash: release.contentHash, previewReceiptFingerprint, compilerFingerprint })
  const geoPass = blueprint.pages.length > 0 && blueprint.pages.every(page => page.sections.length > 0) && blueprint.seoGeo.summaryAnswer.length > 0 && blueprint.seoGeo.canonicalPlaceholder === '{{CANONICAL_ORIGIN}}' && blueprint.seoGeo.evidenceLimitations.length > 0
  if (!geoPass) conflict('Candidate failed deterministic GEO/content structure inspection.')
  const gates = []
  gates.push(await appendGate(repository, base, 'artifact_admission', 'passed', gateFingerprint({ common, gate: 'artifact_admission', manifestHash: admitted.manifest.manifestHash }), ['STRICT_ARTIFACT_ADMISSION_PASS'], ['Admission proves only fixed path, size, hash, and active-content rules.']))
  gates.push(await appendGate(repository, base, 'deterministic_compiler', 'passed', gateFingerprint({ common, gate: 'deterministic_compiler', compilerFingerprint }), ['FIRST_PARTY_COMPILER_REPRODUCED'], ['Compiler result is bound to this blueprint and compiler version.']))
  gates.push(await appendGate(repository, base, 'preview_build', 'passed', gateFingerprint({ common, gate: 'preview_build', previewReceiptFingerprint }), ['PREVIEW_PROVIDER_RECEIPT_MATCHED'], ['A preview build is not a production deployment.']))
  gates.push(await appendGate(repository, base, 'security_static_active_content', 'passed', gateFingerprint({ common, gate: 'security_static_active_content', manifestHash: admitted.manifest.manifestHash }), ['NO_ACTIVE_SCRIPT_OR_EXECUTABLE_HOOK', 'NO_EXTERNAL_FORM_SUBMISSION'], ['Static inspection cannot prove an external hosting platform is uncompromised.']))
  gates.push(await appendGate(repository, base, 'geo_content_structure', 'passed', gateFingerprint({ common, gate: 'geo_content_structure', blueprintHash: manifest.blueprintHash }), ['SEMANTIC_PAGES_PRESENT', 'GEO_SUMMARY_PRESENT', 'EVIDENCE_LIMITATIONS_PRESENT'], ['Structure readiness is not evidence of ranking, citation, traffic, conversion, or ROI.']))
  gates.push(await appendGate(repository, base, 'human_review', 'required', gateFingerprint({ common, gate: 'human_review_required' }), ['OWNER_REVIEW_REQUIRED'], ['No publication or production deployment is authorized until explicit owner approval.']))
  return { gates, contentHash: release.contentHash, previewReceiptFingerprint, allAutomatedRequiredPassed: true, humanReviewRequired: true }
}

export async function inspectManagedSitePreviewGates(ownerUserId: number, releaseId: number, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository()) {
  const release = await repository.findRelease(ownerUserId, releaseId)
  if (!release) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped release was not found.' })
  const gates = await repository.listGateResults(ownerUserId, release.id)
  const latest = new Map<string, ManagedSiteGateResult>()
  for (const gate of [...gates].sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime() || right.id - left.id)) if (!latest.has(gate.gateType)) latest.set(gate.gateType, gate)
  const required = REQUIRED_PREVIEW_GATES.map(gateType => { const gate = latest.get(gateType); return { gateType, present: Boolean(gate), passed: gate?.result === 'passed' && gate.contentHash === release.contentHash, receiptFingerprint: gate?.receiptFingerprint || null, reasonCodes: gate?.reasonCodes || [], limitations: gate?.limitations || [] } })
  const human = latest.get('human_review')
  return { releaseId: release.id, contentHash: release.contentHash, required, allAutomatedRequiredPassed: required.every(item => item.passed), humanReview: human ? { result: human.result, contentHashMatches: human.contentHash === release.contentHash, receiptFingerprint: human.receiptFingerprint } : null, staleOrMismatched: gates.some(gate => gate.contentHash !== release.contentHash) }
}
