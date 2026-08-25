import { createHash } from 'node:crypto'
import type { CreateRoutingPlanInput, DeliveryReceipt, EventKind, Framework, Identity, OpaqueReference, PlannedRouteEvent, PublicationDraft, PublicationTargetInput, ResultRouteEvent, RouteEvent, RouteIntent, RoutingPlan, Transport } from '../../../server/publication-routing'
import { GEOFlow_PINNED_SOURCE_SHA, createRoutingPlan, fingerprint, sha256Hex } from '../../../server/publication-routing'

export const FIXTURE_NOW = 1_756_080_000_000
export const FIXTURE_CONTENT = 'Deterministic approved content for unified publication routing v2.'
export const FIXTURE_CONTENT_HASH = sha256Hex(FIXTURE_CONTENT)
export const FIXTURE_EVIDENCE_HASH = createHash('sha256').update('deterministic-evidence', 'utf8').digest('hex')
export const OWNER: Identity = { id: 'owner-001', label: 'Owner' }
export const CLIENT: Identity = { id: 'client-001', label: 'Client' }

export function opaque(value: string): OpaqueReference {
  return value as OpaqueReference
}

export function makeDraft(overrides: Partial<PublicationDraft> = {}): PublicationDraft {
  const content = overrides.content ?? FIXTURE_CONTENT
  return {
    ownerIdentity: OWNER,
    clientIdentity: CLIENT,
    productionPlanId: 'production-plan-001',
    deliverableId: 'deliverable-001',
    draftId: 'draft-001',
    reviewId: 'review-001',
    draftStage: 'optimized',
    reviewDecision: 'approved_for_delivery',
    riskGateStatus: 'passed',
    evidenceSnapshotHash: FIXTURE_EVIDENCE_HASH,
    contentHash: sha256Hex(content),
    content,
    contentType: 'article',
    language: 'zh-hant',
    sourcePublicationIdentity: 'source-publication-001',
    geoflowSourceSha: GEOFlow_PINNED_SOURCE_SHA,
    ...overrides,
    ...(overrides.content !== undefined && overrides.contentHash === undefined ? { contentHash: sha256Hex(content) } : {}),
  }
}

export function makeTarget(overrides: Partial<PublicationTargetInput> = {}): PublicationTargetInput {
  return {
    targetId: 'target-astro-001',
    siteIdentity: 'site-astro-001',
    framework: 'astro',
    transport: 'first_party_git',
    targetUrl: 'https://astro.routing.discoverystack.dev',
    serviceReference: null,
    credentialReference: opaque('ref-github-app-123'),
    destinationPublicationIdentity: 'destination-publication-astro-001',
    enabled: true,
    ...overrides,
  }
}

export const LEGAL_TARGETS = {
  astroGit: makeTarget(),
  astroSigned: makeTarget({ targetId: 'target-astro-api-001', siteIdentity: 'site-astro-api-001', framework: 'astro', transport: 'first_party_signed_api', targetUrl: 'https://astro-api.routing.discoverystack.dev', credentialReference: opaque('ref-hmac-astro-001'), destinationPublicationIdentity: 'destination-publication-astro-api-001' }),
  nuxtGit: makeTarget({ targetId: 'target-nuxt-001', siteIdentity: 'site-nuxt-001', framework: 'nuxt', transport: 'first_party_git', targetUrl: 'https://nuxt.routing.discoverystack.dev', credentialReference: opaque('ref-github-nuxt-001'), destinationPublicationIdentity: 'destination-publication-nuxt-001' }),
  nuxtSigned: makeTarget({ targetId: 'target-nuxt-api-001', siteIdentity: 'site-nuxt-api-001', framework: 'nuxt', transport: 'first_party_signed_api', targetUrl: 'https://nuxt-api.routing.discoverystack.dev', credentialReference: opaque('ref-hmac-nuxt-001'), destinationPublicationIdentity: 'destination-publication-nuxt-api-001' }),
  wordpress: makeTarget({ targetId: 'target-wordpress-001', siteIdentity: 'site-wordpress-001', framework: 'wordpress', transport: 'wordpress_rest', targetUrl: 'https://wordpress.routing.discoverystack.dev/wp-json', credentialReference: opaque('ref-wordpress-app-001'), destinationPublicationIdentity: 'destination-publication-wordpress-001' }),
  phpAgent: makeTarget({ targetId: 'target-php-001', siteIdentity: 'site-php-001', framework: 'php_agent', transport: 'geoflow_agent', targetUrl: 'https://php.routing.discoverystack.dev/agent', credentialReference: opaque('ref-geoflow-agent-php-001'), destinationPublicationIdentity: 'destination-publication-php-001' }),
  genericHttp: makeTarget({ targetId: 'target-http-001', siteIdentity: 'site-http-001', framework: 'generic_http', transport: 'generic_http', targetUrl: 'https://http.routing.discoverystack.dev/ingest', credentialReference: opaque('ref-generic-http-001'), destinationPublicationIdentity: 'destination-publication-http-001' }),
  geoflowLocal: makeTarget({ targetId: 'target-local-001', siteIdentity: 'site-local-001', framework: 'geoflow_local', transport: 'geoflow_local', targetUrl: null, serviceReference: 'ref-service-local-001', credentialReference: opaque('ref-local-service-001'), destinationPublicationIdentity: 'destination-publication-local-001' }),
  staticSite: makeTarget({ targetId: 'target-static-001', siteIdentity: 'site-static-001', framework: 'static_site', transport: 'geoflow_agent', targetUrl: 'https://static.routing.discoverystack.dev', credentialReference: opaque('ref-geoflow-agent-static-001'), destinationPublicationIdentity: 'destination-publication-static-001' }),
}

export function makeInput(targets: readonly PublicationTargetInput[] = [LEGAL_TARGETS.astroGit], overrides: Partial<CreateRoutingPlanInput> = {}): CreateRoutingPlanInput {
  return { draft: makeDraft(), targets, plannedAt: FIXTURE_NOW, ...overrides }
}

export function makePlan(targets: readonly PublicationTargetInput[] = [LEGAL_TARGETS.astroGit], overrides: Partial<CreateRoutingPlanInput> = {}): RoutingPlan {
  return createRoutingPlan(makeInput(targets, overrides))
}

export function makeReceipt(plan: RoutingPlan, route: RouteIntent = plan.routes[0]!, overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    planFingerprint: plan.planFingerprint,
    routeId: route.routeId,
    targetId: route.targetId,
    siteIdentity: route.siteIdentity,
    sourcePublicationIdentity: route.sourcePublicationIdentity,
    destinationPublicationIdentity: route.destinationPublicationIdentity,
    draftId: route.draftId,
    reviewId: route.reviewId,
    evidenceSnapshotHash: route.evidenceSnapshotHash,
    contentHash: route.contentHash,
    executor: route.executor,
    executorAuthority: route.executorAuthority,
    executorRunId: opaque(`ref-run-${route.targetId}`),
    attempt: 1,
    status: 'delivered',
    plannedAt: plan.plannedAt,
    completedAt: plan.plannedAt + 100,
    occurredAt: plan.plannedAt + 200,
    ...overrides,
  }
}

export function makePlannedEvent(plan: RoutingPlan, route: RouteIntent = plan.routes[0]!, overrides: Partial<PlannedRouteEvent> = {}): PlannedRouteEvent {
  return { planFingerprint: plan.planFingerprint, routeId: route.routeId, sequence: 1, kind: 'planned', attempt: null, executorRunId: null, receiptFingerprint: null, occurredAt: plan.plannedAt + 1, ...overrides }
}

export function makeResultEvent(plan: RoutingPlan, receipt: DeliveryReceipt, sequence = 2, overrides: Partial<ResultRouteEvent> = {}): ResultRouteEvent {
  return { planFingerprint: plan.planFingerprint, routeId: receipt.routeId, sequence, kind: receipt.status, attempt: receipt.attempt, executorRunId: receipt.executorRunId, receiptFingerprint: fingerprint(receipt), occurredAt: receipt.occurredAt, ...overrides }
}

export function makeEvent(plan: RoutingPlan, route: RouteIntent = plan.routes[0]!, sequence = 1, kind: EventKind = 'planned', receipt?: DeliveryReceipt, overrides: Partial<RouteEvent> = {}): RouteEvent {
  if (kind === 'planned') return makePlannedEvent(plan, route, { sequence: 1, ...overrides } as Partial<PlannedRouteEvent>)
  const resultReceipt = receipt ?? makeReceipt(plan, route, { status: kind as DeliveryReceipt['status'] })
  return makeResultEvent(plan, resultReceipt, sequence, overrides as Partial<ResultRouteEvent>)
}

export function targetFor(framework: Framework, transport: Transport, index = 1): PublicationTargetInput {
  return makeTarget({ targetId: `target-${framework}-${index}`, siteIdentity: `site-${framework}-${index}`, framework, transport, targetUrl: framework === 'geoflow_local' ? null : `https://${framework}-${index}.routing.discoverystack.dev`, serviceReference: framework === 'geoflow_local' ? `ref-service-local-${index}` : null, credentialReference: opaque(`ref-${framework}-${index}`), destinationPublicationIdentity: `destination-publication-${framework}-${index}` })
}
