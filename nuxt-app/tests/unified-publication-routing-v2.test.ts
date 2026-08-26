import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_MATRIX,
  GEOFlow_PINNED_SOURCE_SHA,
  RouteEventLedger,
  aggregateEvents,
  canonicalize,
  capabilityFor,
  createRoutingPlan,
  fingerprint,
  guardExternalTargetUrl,
  guardServiceReference,
  isIdempotencyCollision,
  isPlanReplay,
  matrixAllows,
  planFingerprint,
  projectFirstParty,
  projectGeoflow,
  projectPlan,
  routeForReceipt,
  routeIdFor,
  sha256Hex,
  validateReceipt,
  validateReceiptHistory,
  validateRetry,
  validateProjectionIntent,
  validateRoutingPlan,
} from '../server/publication-routing'
import { normalizeMarkdownContent } from '../server/publication-routing/normalization'
import type { CreateRoutingPlanInput, DeliveryReceipt, PublicationTargetInput, RouteEvent, RouteIntent, RoutingPlan } from '../server/publication-routing'
import { FIXTURE_CONTENT, FIXTURE_EVIDENCE_HASH, FIXTURE_NOW, LEGAL_TARGETS, makeDraft, makeEvent, makeInput, makePlan, makeReceipt, makeResultEvent, makeTarget, opaque, targetFor } from './fixtures/publication-routing/fixtures'

function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value))
}

function route(plan: RoutingPlan, index = 0): RouteIntent {
  return plan.routes[index]!
}

function receiptFor(plan: RoutingPlan, index = 0, overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return makeReceipt(plan, route(plan, index), overrides)
}

function plannedThenLedger(plan: RoutingPlan, index = 0): RouteEventLedger {
  const ledger = new RouteEventLedger(plan)
  expect(ledger.append(makeEvent(plan, route(plan, index)))).toMatchObject({ accepted: true })
  return ledger
}

describe('Unified Multi-channel Publication Routing Capability Engine V2 repair', () => {
  describe('fixed capability matrix and derived authority', () => {
    const legal = [
      ['astro', 'first_party_git', 'first_party_git', 'discoverystack_first_party'],
      ['astro', 'first_party_signed_api', 'first_party_signed_api', 'discoverystack_first_party'],
      ['nuxt', 'first_party_git', 'first_party_git', 'discoverystack_first_party'],
      ['nuxt', 'first_party_signed_api', 'first_party_signed_api', 'discoverystack_first_party'],
      ['wordpress', 'wordpress_rest', 'wordpress_rest', 'geoflow_content_engine'],
      ['php_agent', 'geoflow_agent', 'geoflow_agent', 'geoflow_content_engine'],
      ['generic_http', 'generic_http', 'generic_http', 'geoflow_content_engine'],
      ['geoflow_local', 'geoflow_local', 'geoflow_local', 'geoflow_content_engine'],
      ['static_site', 'geoflow_agent', 'geoflow_agent', 'geoflow_content_engine'],
    ] as const
    it.each(legal)('accepts %s/%s and derives %s/%s', (framework, transport, executor, authority) => {
      const capability = capabilityFor(framework, transport)
      expect(capability).toMatchObject({ framework, transport, executor, authority })
      expect(matrixAllows(framework, transport, authority, executor)).toBe(true)
    })
    it('contains exactly the nine fixed capabilities', () => {
      expect(CAPABILITY_MATRIX).toHaveLength(9)
    })
    it('exports the pinned GEOFlow SHA', () => {
      expect(GEOFlow_PINNED_SOURCE_SHA).toBe('9d70db04ee9c5d308f5fa29b4c65834229af9eea')
    })
    it('fails closed for unknown framework', () => {
      expect(capabilityFor('drupal', 'wordpress_rest')).toBeNull()
    })
    it('fails closed for unknown transport', () => {
      expect(capabilityFor('astro', 'wordpress_rest')).toBeNull()
    })
    it('fails closed for null lookup', () => {
      expect(capabilityFor(null, null)).toBeNull()
    })
    it('fails closed for authority mismatch', () => {
      expect(matrixAllows('astro', 'first_party_git', 'geoflow_content_engine', 'first_party_git')).toBe(false)
    })
    it('fails closed for executor mismatch', () => {
      expect(matrixAllows('wordpress', 'wordpress_rest', 'geoflow_content_engine', 'generic_http')).toBe(false)
    })
    it('derives first-party authority for Astro Git', () => {
      expect(makePlan([LEGAL_TARGETS.astroGit]).routes[0]!.executorAuthority).toBe('discoverystack_first_party')
    })
    it('derives first-party authority for Nuxt API', () => {
      expect(makePlan([LEGAL_TARGETS.nuxtSigned]).routes[0]!.executorAuthority).toBe('discoverystack_first_party')
    })
    it('derives GEOFlow authority for WordPress', () => {
      expect(makePlan([LEGAL_TARGETS.wordpress]).routes[0]!.executorAuthority).toBe('geoflow_content_engine')
    })
    it('derives GEOFlow authority for PHP Agent', () => {
      expect(makePlan([LEGAL_TARGETS.phpAgent]).routes[0]!.executorAuthority).toBe('geoflow_content_engine')
    })
    it('does not derive authority from target authority input', () => {
      expect(() => makePlan([makeTarget({ authority: 'geoflow_content_engine' })])).toThrow(/authority/)
    })
    it('does not derive executor from target executor input', () => {
      expect(() => makePlan([makeTarget({ executor: 'wordpress_rest' })])).toThrow(/executor/)
    })
    it('does not accept a caller authority on an otherwise valid target', () => {
      expect(() => makePlan([makeTarget({ authority: 'discoverystack_first_party' })])).toThrow(/authority/)
    })
    it('does not accept a caller executor on an otherwise valid target', () => {
      expect(() => makePlan([makeTarget({ executor: 'generic_http' })])).toThrow(/executor/)
    })
  })

  describe('admission, capacity, identity and text limits', () => {
    it('accepts one target', () => {
      expect(makePlan([LEGAL_TARGETS.astroGit]).routes).toHaveLength(1)
    })
    it('rejects zero targets', () => {
      expect(() => createRoutingPlan(makeInput([]))).toThrow(/1–20/)
    })
    it('accepts twenty targets', () => {
      const targets = Array.from({ length: 20 }, (_, index) => targetFor('astro', 'first_party_git', index + 1))
      expect(makePlan(targets).routes).toHaveLength(20)
    })
    it('rejects twenty-one targets', () => {
      const targets = Array.from({ length: 21 }, (_, index) => targetFor('astro', 'first_party_git', index + 1))
      expect(() => createRoutingPlan(makeInput(targets))).toThrow(/1–20/)
    })
    it('accepts optimized draft', () => {
      expect(makePlan().metadata.draftId).toBe('draft-001')
    })
    it('rejects non-optimized draft', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ draftStage: 'draft' }) })).toThrow(/optimized/)
    })
    it('accepts approved_for_delivery decision', () => {
      expect(makePlan().metadata.reviewId).toBe('review-001')
    })
    it('rejects unapproved decision', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ reviewDecision: 'changes_requested' }) })).toThrow(/approved_for_delivery/)
    })
    it('rejects blocked risk gate', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ riskGateStatus: 'blocked' }) })).toThrow(/risk gate/)
    })
    it('preserves owner identity', () => {
      expect(makePlan().metadata.ownerIdentity.id).toBe('owner-001')
    })
    it('preserves client identity', () => {
      expect(makePlan().metadata.clientIdentity.id).toBe('client-001')
    })
    it('preserves production plan identity', () => {
      expect(makePlan().metadata.productionPlanId).toBe('production-plan-001')
    })
    it('preserves deliverable identity', () => {
      expect(makePlan().metadata.deliverableId).toBe('deliverable-001')
    })
    it('preserves source publication identity', () => {
      expect(makePlan().metadata.sourcePublicationIdentity).toBe('source-publication-001')
    })
    it('preserves evidence hash', () => {
      expect(makePlan().metadata.evidenceSnapshotHash).toBe(FIXTURE_EVIDENCE_HASH)
    })
    it('rejects malformed evidence hash', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ evidenceSnapshotHash: 'evidence' }) })).toThrow(/evidenceSnapshotHash/)
    })
    it('rejects source SHA drift', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ geoflowSourceSha: '0'.repeat(40) }) })).toThrow(/source SHA/)
    })
    it('rejects exact content hash drift', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ contentHash: 'a'.repeat(64) }) })).toThrow(/contentHash/)
    })
    it('does not copy raw content into plan metadata', () => {
      expect(JSON.stringify(makePlan())).not.toContain(FIXTURE_CONTENT)
    })
    it('accepts UTF-8 content within 200000 bytes', () => {
      const content = '內容'.repeat(20_000)
      expect(makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content }) }).metadata.contentHash).toBeDefined()
    })
    it('rejects content beyond 200000 UTF-8 bytes', () => {
      const content = '內容'.repeat(40_001)
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content }) })).toThrow(/content/)
    })
    it('rejects control characters in content', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content: 'bad\u0000content' }) })).toThrow(/control/)
    })
    it('rejects leading whitespace in IDs', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ draftId: ' draft-001' }) })).toThrow(/draftId/)
    })
    it('rejects trailing whitespace in IDs', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ reviewId: 'review-001 ' }) })).toThrow(/reviewId/)
    })
    it('rejects empty owner ID', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ ownerIdentity: { id: '' } }) })).toThrow(/ownerIdentity/)
    })
    it('rejects owner ID over 160 characters', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ ownerIdentity: { id: 'a'.repeat(161) } }) })).toThrow(/ownerIdentity/)
    })
    it('rejects label over 160 characters', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ ownerIdentity: { id: 'owner', label: 'a'.repeat(161) } }) })).toThrow(/label/)
    })
    it('rejects control characters in label', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ ownerIdentity: { id: 'owner', label: 'bad\u0001label' } }) })).toThrow(/control/)
    })
    it('rejects non-safe plannedAt', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { plannedAt: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/plannedAt/)
    })
    it('rejects negative plannedAt', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { plannedAt: -1 })).toThrow(/plannedAt/)
    })
    it('rejects untrimmed idempotency key', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { idempotencyKey: ' key ' })).toThrow(/idempotencyKey/)
    })
    it('rejects idempotency key over 200 characters', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { idempotencyKey: 'a'.repeat(201) })).toThrow(/idempotencyKey/)
    })
    it('rejects disabled target', () => {
      expect(() => makePlan([makeTarget({ enabled: false as never })])).toThrow(/enabled/)
    })
    it('rejects missing enabled target field', () => {
      const target = clone(makeTarget())
      delete target.enabled
      expect(() => makePlan([target as PublicationTargetInput])).toThrow(/target/)
    })
    it('rejects string enabled target field', () => {
      expect(() => makePlan([makeTarget({ enabled: 'true' as never })])).toThrow(/enabled/)
    })
    it('rejects numeric enabled target field', () => {
      expect(() => makePlan([makeTarget({ enabled: 1 as never })])).toThrow(/enabled/)
    })
    it('rejects missing credential reference', () => {
      expect(() => makePlan([makeTarget({ credentialReference: undefined as never })])).toThrow(/credentialReference/)
    })
    it('rejects credential reference with whitespace', () => {
      expect(() => makePlan([makeTarget({ credentialReference: 'ref secret' })])).toThrow(/credentialReference/)
    })
    it('rejects credential reference URL', () => {
      expect(() => makePlan([makeTarget({ credentialReference: 'https://secret.invalid' })])).toThrow(/credentialReference/)
    })
    it('rejects credential reference with secret keyword', () => {
      expect(() => makePlan([makeTarget({ credentialReference: 'ref-token-001' })])).toThrow(/credentialReference/)
    })
    const secretShapedCredentialReferences = [
      ['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['Bearer', ':', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['AKIAIOSFODNN7', 'EXAMPLE'].join(''),
      ['eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'signature'].join(''),
      ['ref-', 'sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['ref-', 'ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['ref-Bearer', ':', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
      ['ref-', 'AKIAIOSFODNN7', 'EXAMPLE'].join(''),
      ['ref-', 'eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'signature'].join(''),
    ]
    it.each(secretShapedCredentialReferences)('rejects raw or disguised secret-shaped credential reference %s', (credentialReference) => {
      expect(() => makePlan([makeTarget({ credentialReference: opaque(credentialReference) })])).toThrow(/credentialReference/)
    })
    it('requires the fixed ref namespace for opaque references', () => {
      expect(() => makePlan([makeTarget({ credentialReference: opaque('ordinary-handle-001') })])).toThrow(/credentialReference/)
    })
  })

  describe('canonicalization, deduplication and deterministic planning', () => {
    it('canonicalizes sorted plain object keys', () => {
      expect(canonicalize({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 })
    })
    it('canonicalizes nested object keys', () => {
      expect(canonicalize({ outer: { z: 1, a: 2 } })).toEqual({ outer: { a: 2, z: 1 } })
    })
    it('canonicalizes arrays in input order', () => {
      expect(canonicalize([2, 1])).toEqual([2, 1])
    })
    it('canonicalizes negative zero as zero', () => {
      expect(canonicalize(-0)).toBe(0)
    })
    it('rejects undefined canonical value', () => {
      expect(() => canonicalize(undefined)).toThrow(/unsupported/)
    })
    it('rejects bigint canonical value', () => {
      expect(() => canonicalize(1n)).toThrow(/unsupported/)
    })
    it('rejects function canonical value', () => {
      expect(() => canonicalize(() => 1)).toThrow(/unsupported/)
    })
    it('rejects symbol canonical value', () => {
      expect(() => canonicalize(Symbol('x'))).toThrow(/unsupported/)
    })
    it('rejects NaN canonical value', () => {
      expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/)
    })
    it('rejects Infinity canonical value', () => {
      expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
    })
    it('rejects Date canonical value', () => {
      expect(() => canonicalize(new Date('2026-01-01T00:00:00.000Z'))).toThrow(/plain/)
    })
    it('rejects Map canonical value', () => {
      expect(() => canonicalize(new Map())).toThrow(/plain/)
    })
    it('rejects Set canonical value', () => {
      expect(() => canonicalize(new Set())).toThrow(/plain/)
    })
    it('rejects class instance canonical value', () => {
      class Value { readonly value = 1 }
      expect(() => canonicalize(new Value())).toThrow(/plain/)
    })
    it('rejects symbol object key', () => {
      expect(() => canonicalize({ [Symbol('x')]: 1 })).toThrow(/symbol/)
    })
    it('rejects circular canonical value', () => {
      const value: Record<string, unknown> = {}
      value.self = value
      expect(() => canonicalize(value)).toThrow(/circular/)
    })
    it('rejects getter exception canonical value', () => {
      const value = { get broken(): string { throw new Error('getter') } }
      expect(() => canonicalize(value)).toThrow(/getter/)
    })
    it('rejects sparse array canonical value', () => {
      const value: unknown[] = []
      value.length = 1
      expect(() => canonicalize(value)).toThrow(/sparse/)
    })
    it('rejects array extra field canonical value', () => {
      const value = [1] as unknown as { 0: number; extra: number }
      value.extra = 2
      expect(() => canonicalize(value)).toThrow(/extra/)
    })
    it('rejects exact duplicate target', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.astroGit])).toThrow(/duplicate canonical/)
    })
    it('rejects canonical URL duplicate with trailing slash', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit, makeTarget({ targetId: 'target-2', siteIdentity: 'site-2', targetUrl: 'https://astro.routing.discoverystack.dev/' })])).toThrow(/duplicate canonical/)
    })
    it('rejects same-site destination publication duplicate', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit, makeTarget({ targetId: 'target-2', siteIdentity: LEGAL_TARGETS.astroGit.siteIdentity, targetUrl: 'https://different.routing.discoverystack.dev', destinationPublicationIdentity: LEGAL_TARGETS.astroGit.destinationPublicationIdentity })])).toThrow(/duplicate site destination/)
    })
    it('allows same destination identity on different sites', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, makeTarget({ targetId: 'target-2', siteIdentity: 'site-2', targetUrl: 'https://site-2.routing.discoverystack.dev', destinationPublicationIdentity: LEGAL_TARGETS.astroGit.destinationPublicationIdentity })])
      expect(plan.routes).toHaveLength(2)
    })
    it('keeps source identity equal across routes', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      expect(plan.routes.map((entry) => entry.sourcePublicationIdentity)).toEqual(['source-publication-001', 'source-publication-001'])
    })
    it('keeps destination identity target-specific', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      expect(plan.routes.map((entry) => entry.destinationPublicationIdentity)).toEqual(['destination-publication-astro-001', 'destination-publication-wordpress-001'])
    })
    it('orders uppercase code units before lowercase code units', () => {
      const plan = makePlan([makeTarget({ targetId: 'z', siteIdentity: 'z', destinationPublicationIdentity: 'z', targetUrl: 'https://z.routing.discoverystack.dev' }), makeTarget({ targetId: 'A', siteIdentity: 'A', destinationPublicationIdentity: 'A', targetUrl: 'https://a.routing.discoverystack.dev' })])
      expect(plan.routes.map((entry) => entry.targetId)).toEqual(['A', 'z'])
    })
    it('has no locale-sensitive ordering dependency', () => {
      const plan = makePlan([makeTarget({ targetId: 'ä', siteIdentity: 'ä', destinationPublicationIdentity: 'ä', targetUrl: 'https://a.routing.discoverystack.dev' }), makeTarget({ targetId: 'z', siteIdentity: 'z', destinationPublicationIdentity: 'z', targetUrl: 'https://z.routing.discoverystack.dev' })])
      expect(plan.routes.map((entry) => entry.targetId)).toEqual(['z', 'ä'])
    })
    it('produces the same fingerprint for reordered targets', () => {
      const left = makePlan([LEGAL_TARGETS.wordpress, LEGAL_TARGETS.astroGit])
      const right = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      expect(left.planFingerprint).toBe(right.planFingerprint)
    })
    it('produces the same route IDs for reordered targets', () => {
      const left = makePlan([LEGAL_TARGETS.wordpress, LEGAL_TARGETS.astroGit])
      const right = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      expect(left.routes.map((entry) => entry.routeId)).toEqual(right.routes.map((entry) => entry.routeId))
    })
    it('changes route ID when source publication identity changes', () => {
      const left = makePlan()
      const right = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ sourcePublicationIdentity: 'source-publication-002' }) })
      expect(left.routes[0]!.routeId).not.toBe(right.routes[0]!.routeId)
    })
    it('changes route ID when destination publication identity changes', () => {
      const left = makePlan()
      const right = makePlan([makeTarget({ destinationPublicationIdentity: 'destination-publication-002' })])
      expect(left.routes[0]!.routeId).not.toBe(right.routes[0]!.routeId)
    })
    it('changes plan fingerprint when source identity changes', () => {
      const left = makePlan()
      const right = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ sourcePublicationIdentity: 'source-publication-002' }) })
      expect(left.planFingerprint).not.toBe(right.planFingerprint)
    })
    it('changes plan fingerprint when destination identity changes', () => {
      const left = makePlan()
      const right = makePlan([makeTarget({ destinationPublicationIdentity: 'destination-publication-002' })])
      expect(left.planFingerprint).not.toBe(right.planFingerprint)
    })
    it('changes plan fingerprint when content changes', () => {
      const left = makePlan()
      const right = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content: `${FIXTURE_CONTENT} changed` }) })
      expect(left.planFingerprint).not.toBe(right.planFingerprint)
    })
    it('changes plan fingerprint when evidence changes', () => {
      const left = makePlan()
      const right = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ evidenceSnapshotHash: 'b'.repeat(64) }) })
      expect(left.planFingerprint).not.toBe(right.planFingerprint)
    })
    it('changes plan fingerprint when plannedAt changes', () => {
      expect(makePlan().planFingerprint).not.toBe(makePlan([LEGAL_TARGETS.astroGit], { plannedAt: FIXTURE_NOW + 1 }).planFingerprint)
    })
    it('binds automatic idempotency key to plan data', () => {
      expect(makePlan().idempotencyKey).toContain('publication-routing-v2:')
    })
    it('recognizes idempotency replay', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit], { idempotencyKey: 'same-key' })
      expect(isPlanReplay(plan, { idempotencyKey: 'same-key', planFingerprint: plan.planFingerprint })).toBe(true)
    })
    it('recognizes idempotency collision', () => {
      const left = makePlan([LEGAL_TARGETS.astroGit], { idempotencyKey: 'same-key' })
      const right = makePlan([LEGAL_TARGETS.nuxtGit], { idempotencyKey: 'same-key' })
      expect(isIdempotencyCollision(left, right)).toBe(true)
    })
    it('does not collide with different idempotency key', () => {
      const left = makePlan([LEGAL_TARGETS.astroGit], { idempotencyKey: 'key-a' })
      const right = makePlan([LEGAL_TARGETS.nuxtGit], { idempotencyKey: 'key-b' })
      expect(isIdempotencyCollision(left, right)).toBe(false)
    })
    it('does not replay with different key', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit], { idempotencyKey: 'key-a' })
      expect(isPlanReplay(plan, { idempotencyKey: 'key-b', planFingerprint: plan.planFingerprint })).toBe(false)
    })
    it('keeps a plan planned after construction', () => {
      expect(makePlan().status).toBe('planned')
    })
  })

  describe('runtime RoutingPlan verifier', () => {
    it('verifies a planner-produced plan', () => {
      const plan = makePlan()
      expect(validateRoutingPlan(plan)).toMatchObject({ valid: true, plan })
    })
    it('returns normalized verified plan', () => {
      const plan = makePlan()
      const result = validateRoutingPlan(plan)
      expect(result.valid && result.plan).toEqual(plan)
    })
    it('returns discriminated invalid result', () => {
      const result = validateRoutingPlan(null)
      expect(result).toMatchObject({ valid: false, plan: null })
      expect(result.reasonCodes.length).toBeGreaterThan(0)
    })
    it('rejects unknown top-level field', () => {
      const forged = { ...clone(makePlan()), extra: true }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects missing top-level field', () => {
      const forged = clone(makePlan())
      delete forged.idempotencyKey
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects wrong version', () => {
      const forged = { ...clone(makePlan()), version: 'publication-routing-v1' }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects wrong status', () => {
      const forged = { ...clone(makePlan()), status: 'delivered' }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects unsafe plannedAt', () => {
      const forged = { ...clone(makePlan()), plannedAt: Number.MAX_SAFE_INTEGER + 1 }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects zero routes', () => {
      const forged = { ...clone(makePlan()), routes: [] }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects twenty-one routes', () => {
      const plan = makePlan()
      const forged = { ...clone(plan), routes: Array.from({ length: 21 }, () => clone(plan.routes[0]!)) }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects metadata unknown field', () => {
      const plan = clone(makePlan())
      const forged = { ...plan, metadata: { ...plan.metadata, extra: true } }
      expect(validateRoutingPlan(forged).valid).toBe(false)
    })
    it('rejects metadata source identity drift from route', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.sourcePublicationIdentity = 'source-other'
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects route unknown field', () => {
      const plan = clone(makePlan())
      plan.routes[0] = { ...plan.routes[0]!, extra: true } as never
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects forged route executor', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.executor = 'wordpress_rest' as never
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects forged route authority', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.executorAuthority = 'geoflow_content_engine' as never
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects forged route ID', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.routeId = 'route_forged'
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects forged plan fingerprint', () => {
      const plan = clone(makePlan())
      plan.planFingerprint = 'f'.repeat(64)
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects forged route content hash with old fingerprint', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.contentHash = 'e'.repeat(64)
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects forged route ordering', () => {
      const plan = clone(makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress]))
      plan.routes.reverse()
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects duplicate route IDs', () => {
      const plan = clone(makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress]))
      plan.routes[1]!.routeId = plan.routes[0]!.routeId
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects duplicate route identity', () => {
      const plan = clone(makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress]))
      plan.routes[1]!.targetId = plan.routes[0]!.targetId
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects duplicate site destination identity', () => {
      const plan = clone(makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress]))
      plan.routes[1]!.siteIdentity = plan.routes[0]!.siteIdentity
      plan.routes[1]!.destinationPublicationIdentity = plan.routes[0]!.destinationPublicationIdentity
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects route planned status drift', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.status = 'delivered' as never
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects route target URL guard drift', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.targetUrl = 'https://example.com'
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects route local URL guard drift', () => {
      const plan = clone(makePlan([LEGAL_TARGETS.geoflowLocal]))
      plan.routes[0]!.targetUrl = 'https://local.routing.discoverystack.dev'
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects route credential reference drift', () => {
      const plan = clone(makePlan())
      plan.routes[0]!.credentialReference = 'ref-other' as never
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects circular plan', () => {
      const plan = clone(makePlan()) as Record<string, unknown>
      plan.circular = plan
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects plan getter exception', () => {
      const plan = { get version(): string { throw new Error('getter') } }
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects plan Proxy exception', () => {
      const plan = new Proxy({}, { get(): never { throw new Error('proxy') } })
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('rejects plan symbol key', () => {
      const plan = { ...clone(makePlan()), [Symbol('unknown')]: true }
      expect(validateRoutingPlan(plan).valid).toBe(false)
    })
    it('recomputes route ID equal to canonical route seed', () => {
      const plan = makePlan()
      expect(routeIdFor(route(plan))).toBe(route(plan).routeId)
    })
    it('recomputes plan fingerprint equal to canonical plan', () => {
      const plan = makePlan()
      expect(planFingerprint(plan)).toBe(plan.planFingerprint)
    })
    it('does not throw on malformed plan values', () => {
      expect(() => validateRoutingPlan({ routes: Symbol('bad') })).not.toThrow()
    })
  })

  describe('target guard and SSRF boundary', () => {
    const blockedUrls = [
      ['http protocol', 'http://public.routing.discoverystack.dev'],
      ['ftp protocol', 'ftp://public.routing.discoverystack.dev'],
      ['port 80', 'https://public.routing.discoverystack.dev:80/path'],
      ['port 8443', 'https://public.routing.discoverystack.dev:8443/path'],
      ['credentials', 'https://user:pass@public.routing.discoverystack.dev'],
      ['fragment', 'https://public.routing.discoverystack.dev/path#fragment'],
      ['alt', 'https://alt/'],
      ['arpa', 'https://arpa/'],
      ['example', 'https://example/'],
      ['example.com', 'https://example.com/'],
      ['example.net', 'https://example.net/'],
      ['example.org', 'https://example.org/'],
      ['example subdomain', 'https://sub.example.net/path'],
      ['invalid', 'https://invalid/'],
      ['local', 'https://local/'],
      ['localhost', 'https://localhost/'],
      ['localhost subdomain', 'https://x.localhost/'],
      ['onion', 'https://x.onion/'],
      ['test', 'https://x.test/'],
      ['home.arpa', 'https://home.arpa/'],
      ['resolver.arpa', 'https://x.resolver.arpa/'],
      ['single label', 'https://intranet/path'],
      ['trailing dot', 'https://example.com./path'],
      ['loopback IPv4', 'https://127.0.0.1/'],
      ['private IPv4 10', 'https://10.0.0.1/'],
      ['private IPv4 172', 'https://172.16.0.1/'],
      ['private IPv4 192', 'https://192.168.1.1/'],
      ['link local IPv4', 'https://169.254.1.1/'],
      ['reserved IPv4', 'https://0.0.0.0/'],
      ['documentation IPv4', 'https://192.0.2.1/'],
      ['integer IPv4', 'https://2130706433/'],
      ['hex IPv4', 'https://0x7f000001/'],
      ['octal IPv4', 'https://0177.0.0.1/'],
      ['loopback IPv6', 'https://[::1]/'],
      ['unspecified IPv6', 'https://[::]/'],
      ['IPv4-compatible IPv6', 'https://[::192.0.2.1]/'],
      ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/'],
      ['translated IPv6', 'https://[64:ff9b::192.0.2.1]/'],
      ['translated IPv6 longer', 'https://[64:ff9b:1::1]/'],
      ['discard IPv6', 'https://[100::1]/'],
      ['discard IPv6 second', 'https://[100:0:0:1::1]/'],
      ['unique local IPv6', 'https://[fc00::1]/'],
      ['link local IPv6', 'https://[fe80::1]/'],
      ['multicast IPv6', 'https://[ff00::1]/'],
      ['documentation IPv6', 'https://[2001:db8::1]/'],
      ['ORCHID IPv6', 'https://[2001:20::1]/'],
      ['benchmark IPv6', 'https://[2001:30::1]/'],
      ['6to4 IPv6', 'https://[2002::1]/'],
      ['documentation IPv6 3fff', 'https://[3fff::1]/'],
      ['SRv6 IPv6 5f00', 'https://[5f00::1]/'],
      ['Unicode hostname', 'https://ｅxample.com/'],
      ['zone ID', 'https://[fe80::1%25eth0]/'],
      ['token query key', 'https://public.routing.discoverystack.dev/?access_token=abc'],
      ['password query key', 'https://public.routing.discoverystack.dev/?password=abc'],
      ['bearer query value', 'https://public.routing.discoverystack.dev/?x=Bearer%20abc'],
      ['JWT query value', 'https://public.routing.discoverystack.dev/?x=aaa.bbb.ccc'],
    ] as const
    it.each(blockedUrls)('blocks %s', (_name, url) => {
      expect(guardExternalTargetUrl(url).valid).toBe(false)
    })
    it('accepts public HTTPS under routing.discoverystack.dev', () => {
      expect(guardExternalTargetUrl('https://public.routing.discoverystack.dev/path').valid).toBe(true)
    })
    it('accepts explicit port 443', () => {
      expect(guardExternalTargetUrl('https://public.routing.discoverystack.dev:443/path').valid).toBe(true)
    })
    it('accepts a public multi-label hostname', () => {
      expect(guardExternalTargetUrl('https://a.b.routing.discoverystack.dev/path').valid).toBe(true)
    })
    it('does not perform DNS lookup for synthetic public hostname', () => {
      expect(guardExternalTargetUrl('https://synthetic.routing.discoverystack.dev').valid).toBe(true)
    })
    it('rejects malformed URL', () => {
      expect(guardExternalTargetUrl('not a URL').valid).toBe(false)
    })
    it('rejects null URL', () => {
      expect(guardExternalTargetUrl(null).valid).toBe(false)
    })
    it('rejects URL over 2048 characters', () => {
      expect(guardExternalTargetUrl(`https://public.routing.discoverystack.dev/${'a'.repeat(2048)}`).valid).toBe(false)
    })
    it('rejects external target without URL', () => {
      expect(() => makePlan([makeTarget({ targetUrl: null })])).toThrow(/URL/)
    })
    it('rejects external target with service reference', () => {
      expect(() => makePlan([makeTarget({ serviceReference: 'ref-service-001' })])).toThrow(/SERVICE_REFERENCE|EXTERNAL_SERVICE_REFERENCE|GEOFLOW_LOCAL_SERVICE_REFERENCE/ )
    })
    it('accepts opaque local service reference', () => {
      expect(guardServiceReference('ref-service-local-001').valid).toBe(true)
    })
    it('rejects local service reference URL', () => {
      expect(guardServiceReference('https://local.routing.discoverystack.dev').valid).toBe(false)
    })
    it('rejects local service reference with secret keyword', () => {
      expect(guardServiceReference('ref-token-local').valid).toBe(false)
    })
    it('rejects local target URL even with service reference', () => {
      expect(() => makePlan([makeTarget({ framework: 'geoflow_local', transport: 'geoflow_local', targetUrl: 'https://local.routing.discoverystack.dev', serviceReference: 'ref-service-local-001' })])).toThrow(/caller URL|GEOFLOW_LOCAL_CALLER_URL/ )
    })
    it('rejects local target without service reference', () => {
      expect(() => makePlan([makeTarget({ framework: 'geoflow_local', transport: 'geoflow_local', targetUrl: null, serviceReference: null })])).toThrow(/SERVICE_REFERENCE|EXTERNAL_SERVICE_REFERENCE|GEOFLOW_LOCAL_SERVICE_REFERENCE/ )
    })
    it('accepts a valid local target', () => {
      expect(makePlan([LEGAL_TARGETS.geoflowLocal]).routes[0]!.serviceReference).toBe('ref-service-local-001')
    })
    it('rejects a local target with external transport', () => {
      expect(() => makePlan([makeTarget({ framework: 'geoflow_local', transport: 'generic_http', targetUrl: null, serviceReference: 'ref-service-local-001' })])).toThrow(/unsupported capability/)
    })
    it('rejects a hostname containing a zone marker', () => {
      expect(guardExternalTargetUrl('https://foo%25bar.routing.discoverystack.dev').valid).toBe(false)
    })
    it.each(['https://www.éxample.com/path', 'https://safe.例子.com/path'])('rejects IDNA/Punycode in every hostname label: %s', (url) => {
      expect(guardExternalTargetUrl(url).valid).toBe(false)
    })
    it.each([
      'https://192.31.196.1/',
      'https://192.52.193.1/',
      'https://192.88.99.1/',
      'https://192.175.48.1/',
      'https://[2001::1]/',
      'https://[2001:2::1]/',
      'https://[2620:4f:8000::1]/',
      'https://[4000::1]/',
    ])('rejects additional IANA special/reserved address %s', (url) => {
      expect(guardExternalTargetUrl(url).valid).toBe(false)
    })
    it('continues to accept allocated public IPv6', () => {
      expect(guardExternalTargetUrl('https://[2606:4700:4700::1111]/').valid).toBe(true)
    })
    it('rejects an explicit empty query sensitive value', () => {
      expect(guardExternalTargetUrl('https://public.routing.discoverystack.dev/?token=').valid).toBe(false)
    })
    it('rejects query key containing credential term', () => {
      expect(guardExternalTargetUrl('https://public.routing.discoverystack.dev/?my_credential_ref=x').valid).toBe(false)
    })
  })

  describe('verified projections and identity contract', () => {
    it('projects Astro Git with source and destination identities', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit])
      expect(projectFirstParty(plan)[0]).toMatchObject({ planFingerprint: plan.planFingerprint, sourcePublicationIdentity: 'source-publication-001', destinationPublicationIdentity: 'destination-publication-astro-001', executor: 'first_party_git', executorAuthority: 'discoverystack_first_party' })
    })
    it('projects Astro signed API', () => {
      expect(projectFirstParty(makePlan([LEGAL_TARGETS.astroSigned]))[0]!.transport).toBe('first_party_signed_api')
    })
    it('projects Nuxt Git', () => {
      expect(projectFirstParty(makePlan([LEGAL_TARGETS.nuxtGit]))[0]!.framework).toBe('nuxt')
    })
    it('projects Nuxt signed API', () => {
      expect(projectFirstParty(makePlan([LEGAL_TARGETS.nuxtSigned]))[0]!.executor).toBe('first_party_signed_api')
    })
    it('projects WordPress REST', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.wordpress]))[0]).toMatchObject({ framework: 'wordpress', transport: 'wordpress_rest', executor: 'wordpress_rest', executorAuthority: 'geoflow_content_engine', geoflowSourceSha: GEOFlow_PINNED_SOURCE_SHA })
    })
    it('projects PHP Agent', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.phpAgent]))[0]).toMatchObject({ framework: 'php_agent', executor: 'geoflow_agent' })
    })
    it('projects Generic HTTP', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.genericHttp]))[0]).toMatchObject({ framework: 'generic_http', executor: 'generic_http' })
    })
    it('projects GEOFlow Local without URL', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.geoflowLocal]))[0]).toMatchObject({ framework: 'geoflow_local', targetUrl: null, serviceReference: 'ref-service-local-001' })
    })
    it('projects Static Site through GEOFlow Agent', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.staticSite]))[0]).toMatchObject({ framework: 'static_site', executor: 'geoflow_agent' })
    })
    it('projects all legal routes into separate projections', () => {
      const projection = projectPlan(makePlan(Object.values(LEGAL_TARGETS)))
      expect(projection.firstParty).toHaveLength(4)
      expect(projection.geoflow).toHaveLength(5)
    })
    it('preserves content type in first-party projection', () => {
      expect(projectFirstParty(makePlan())[0]!.contentType).toBe('article')
    })
    it('preserves language in GEOFlow projection', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.wordpress]))[0]!.language).toBe('zh-hant')
    })
    it('preserves evidence hash in first-party projection', () => {
      expect(projectFirstParty(makePlan())[0]!.evidenceSnapshotHash).toBe(FIXTURE_EVIDENCE_HASH)
    })
    it('preserves review ID in GEOFlow projection', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.wordpress]))[0]!.reviewId).toBe('review-001')
    })
    it('preserves opaque credential references without resolved secrets', () => {
      const projection = projectPlan(makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress]))
      expect(projection.firstParty[0]!.credentialReference).toBe('ref-github-app-123')
      expect(projection.geoflow[0]!.credentialReference).toBe('ref-wordpress-app-001')
      expect(JSON.stringify(projection)).not.toContain('Bearer ')
      expect(JSON.stringify(projection)).not.toContain('api_key')
    })
    it('does not include raw content in projections', () => {
      expect(JSON.stringify(projectPlan(makePlan()))).not.toContain(FIXTURE_CONTENT)
    })
    it('fails closed for forged authority before first-party projection', () => {
      const forged = clone(makePlan([LEGAL_TARGETS.wordpress]))
      forged.routes[0]!.executorAuthority = 'discoverystack_first_party' as never
      expect(() => projectFirstParty(forged)).toThrow(/invalid routing plan/)
    })
    it('fails closed for forged executor before first-party projection', () => {
      const forged = clone(makePlan([LEGAL_TARGETS.astroGit]))
      forged.routes[0]!.executor = 'wordpress_rest' as never
      expect(() => projectFirstParty(forged)).toThrow(/invalid routing plan/)
    })
    it('fails closed for forged framework before GEOFlow projection', () => {
      const forged = clone(makePlan([LEGAL_TARGETS.wordpress]))
      forged.routes[0]!.framework = 'astro'
      expect(() => projectGeoflow(forged)).toThrow(/invalid routing plan/)
    })
    it('fails closed for forged route URL before projection', () => {
      const forged = clone(makePlan())
      forged.routes[0]!.targetUrl = 'https://example.com'
      expect(() => projectPlan(forged)).toThrow(/invalid routing plan/)
    })
    it('fails closed for projection plan extra field', () => {
      expect(() => projectPlan({ ...clone(makePlan()), extra: true })).toThrow(/invalid routing plan/)
    })
    it('keeps verified plan status planned after projection', () => {
      const plan = makePlan()
      projectPlan(plan)
      expect(plan.status).toBe('planned')
    })
    it('does not call an executor during first-party projection', () => {
      expect(projectFirstParty(makePlan()).length).toBe(1)
    })
    it('does not call an executor during GEOFlow projection', () => {
      expect(projectGeoflow(makePlan([LEGAL_TARGETS.wordpress])).length).toBe(1)
    })
  })

  describe('strict receipt validation, replay and collision', () => {
    it('accepts a fully bound delivered receipt', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan))).toMatchObject({ valid: true, replay: false, collision: false })
    })
    it('binds source publication identity', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { sourcePublicationIdentity: 'wrong-source' })).valid).toBe(false)
    })
    it('binds destination publication identity', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { destinationPublicationIdentity: 'wrong-destination' })).valid).toBe(false)
    })
    it('binds executor', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { executor: 'wordpress_rest' as never })).valid).toBe(false)
    })
    it('binds executor authority', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { executorAuthority: 'geoflow_content_engine' })).valid).toBe(false)
    })
    it('rejects unknown owned status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: 'owned' as never })).valid).toBe(false)
    })
    it('rejects success status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: 'success' as never })).valid).toBe(false)
    })
    it('rejects completed status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: 'completed' as never })).valid).toBe(false)
    })
    it('rejects published status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: 'published' as never })).valid).toBe(false)
    })
    it('rejects planned status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: 'planned' as never })).valid).toBe(false)
    })
    it('rejects undefined status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: undefined as never })).valid).toBe(false)
    })
    it('rejects null status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: null as never })).valid).toBe(false)
    })
    it('rejects numeric status', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { status: 1 as never })).valid).toBe(false)
    })
    it('rejects unknown receipt field', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, { ...receiptFor(plan), extra: true })).toMatchObject({ valid: false })
    })
    it('rejects missing receipt field', () => {
      const plan = makePlan()
      const value = clone(receiptFor(plan))
      delete value.executor
      expect(validateReceipt(plan, value)).toMatchObject({ valid: false })
    })
    it('rejects wrong plan fingerprint', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { planFingerprint: 'f'.repeat(64) })).valid).toBe(false)
    })
    it('rejects wrong route ID', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { routeId: 'route-missing' })).valid).toBe(false)
    })
    it('rejects wrong target ID', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { targetId: 'target-wrong' })).valid).toBe(false)
    })
    it('rejects wrong draft ID', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { draftId: 'draft-wrong' })).valid).toBe(false)
    })
    it('rejects wrong review ID', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { reviewId: 'review-wrong' })).valid).toBe(false)
    })
    it('rejects stale evidence hash', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { evidenceSnapshotHash: 'e'.repeat(64) })).valid).toBe(false)
    })
    it('rejects stale content hash', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { contentHash: 'c'.repeat(64) })).valid).toBe(false)
    })
    it('rejects zero attempt', () => {
      expect(validateReceipt(makePlan(), receiptFor(makePlan(), 0, { attempt: 0 })).valid).toBe(false)
    })
    it('rejects attempt eleven', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { attempt: 11 })).valid).toBe(false)
    })
    it('rejects fractional attempt', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { attempt: 1.5 })).valid).toBe(false)
    })
    it('rejects attempt two without attempt one history', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { attempt: 2, executorRunId: opaque('ref-executor-run-002') })).reasonCodes).toContain('RECEIPT_PREVIOUS_ATTEMPT_MISSING')
    })
    it('accepts attempt two with full previous history', () => {
      const plan = makePlan()
      const first = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-executor-run-001'), attempt: 1 })
      const second = receiptFor(plan, 0, { status: 'delivered', executorRunId: opaque('ref-executor-run-002'), attempt: 2, completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
      expect(validateReceipt(plan, second, [first])).toMatchObject({ valid: true, replay: false })
    })
    it('accepts exact receipt replay', () => {
      const plan = makePlan()
      const receipt = receiptFor(plan)
      expect(validateReceipt(plan, receipt, [receipt])).toMatchObject({ valid: true, replay: true, collision: false })
    })
    it('marks same route attempt different receipt as collision', () => {
      const plan = makePlan()
      const first = receiptFor(plan)
      const changed = receiptFor(plan, 0, { executorRunId: opaque('ref-executor-run-002') })
      expect(validateReceipt(plan, changed, [first])).toMatchObject({ valid: false, replay: false, collision: true })
    })
    it('rejects executorRunId reused by different attempt', () => {
      const plan = makePlan()
      const first = receiptFor(plan, 0, { status: 'failed', attempt: 1, executorRunId: opaque('ref-same-run') })
      const second = receiptFor(plan, 0, { attempt: 2, executorRunId: opaque('ref-same-run'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
      expect(validateReceipt(plan, second, [first])).toMatchObject({ valid: false })
    })
    it('rejects delivered route new receipt', () => {
      const plan = makePlan()
      const delivered = receiptFor(plan, 0, { status: 'delivered', attempt: 1 })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-executor-run-002') })
      expect(validateReceipt(plan, next, [delivered])).toMatchObject({ valid: false })
    })
    it('rejects blocked route new receipt', () => {
      const plan = makePlan()
      const blocked = receiptFor(plan, 0, { status: 'blocked', attempt: 1 })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-executor-run-002') })
      expect(validateReceipt(plan, next, [blocked])).toMatchObject({ valid: false })
    })
    it('rejects plannedAt after completedAt', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { completedAt: plan.plannedAt - 1 })).valid).toBe(false)
    })
    it('rejects completedAt after occurredAt', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { completedAt: plan.plannedAt + 200, occurredAt: plan.plannedAt + 100 })).valid).toBe(false)
    })
    it('rejects plannedAt drift', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { plannedAt: plan.plannedAt + 1 })).valid).toBe(false)
    })
    it('rejects non-opaque executorRunId URL', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { executorRunId: opaque('https://run.routing.discoverystack.dev') })).valid).toBe(false)
    })
    it('rejects executorRunId with token keyword', () => {
      const plan = makePlan()
      expect(validateReceipt(plan, receiptFor(plan, 0, { executorRunId: opaque('ref-token-run') })).valid).toBe(false)
    })
    it('rejects null receipt', () => {
      expect(validateReceipt(makePlan(), null)).toMatchObject({ valid: false, collision: false })
    })
    it('rejects receipt getter exception', () => {
      const plan = makePlan()
      const value = { get routeId(): string { throw new Error('getter') } }
      expect(validateReceipt(plan, value)).toMatchObject({ valid: false })
    })
    it('rejects receipt Proxy exception', () => {
      const plan = makePlan()
      const value = new Proxy({}, { get(): never { throw new Error('proxy') } })
      expect(validateReceipt(plan, value)).toMatchObject({ valid: false })
    })
    it('routeForReceipt validates before returning route', () => {
      const plan = makePlan()
      expect(routeForReceipt(plan, receiptFor(plan))).toMatchObject({ routeId: plan.routes[0]!.routeId })
    })
    it('routeForReceipt rejects forged receipt', () => {
      const plan = makePlan()
      expect(routeForReceipt(plan, receiptFor(plan, 0, { contentHash: 'c'.repeat(64) }))).toBeNull()
    })
  })

  describe('retry history and time contract', () => {
    it('accepts failed attempt one to delivered attempt two', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', attempt: 1, executorRunId: opaque('ref-run-001'), completedAt: plan.plannedAt + 100, occurredAt: plan.plannedAt + 200 })
      const next = receiptFor(plan, 0, { status: 'delivered', attempt: 2, executorRunId: opaque('ref-run-002'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
      expect(validateRetry(plan, previous, next, [previous], 3)).toMatchObject({ valid: true })
    })
    it('accepts retry_wait to failed', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'retry_wait', attempt: 1, executorRunId: opaque('ref-run-001'), completedAt: plan.plannedAt + 100, occurredAt: plan.plannedAt + 200 })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
      expect(validateRetry(plan, previous, next, [previous], 3).valid).toBe(true)
    })
    it('rejects retry from delivered', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'delivered', attempt: 1, executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry from blocked', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'blocked', attempt: 1, executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects attempt jump', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', attempt: 1, executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 3, executorRunId: opaque('ref-run-003') })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry beyond maximum', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 3, executorRunId: opaque('ref-run-003') })
      expect(validateRetry(plan, previous, next, [previous, receiptFor(plan, 0, { status: 'failed', attempt: 1, executorRunId: opaque('ref-run-001') })], 2).valid).toBe(false)
    })
    it('rejects maximumAttempts zero', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(validateRetry(plan, previous, next, [previous], 0).valid).toBe(false)
    })
    it('rejects maximumAttempts eleven', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(validateRetry(plan, previous, next, [previous], 11).valid).toBe(false)
    })
    it('rejects same executor run ID', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-001') })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects executor run ID used in history', () => {
      const plan = makePlan()
      const history = [receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-history'), attempt: 1 })]
      const previous = history[0]!
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-history') })
      expect(validateRetry(plan, previous, next, history).valid).toBe(false)
    })
    it('rejects retry lineage source drift', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), sourcePublicationIdentity: 'source-other' })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry lineage destination drift', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), destinationPublicationIdentity: 'destination-other' })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry route drift', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 1, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry content drift', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), contentHash: 'd'.repeat(64) })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry evidence drift', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), evidenceSnapshotHash: 'd'.repeat(64) })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry plan fingerprint drift', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), planFingerprint: 'd'.repeat(64) })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects retry time rollback against previous occurredAt', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001'), completedAt: plan.plannedAt + 100, occurredAt: plan.plannedAt + 200 })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), completedAt: plan.plannedAt + 50, occurredAt: plan.plannedAt + 60 })
      expect(validateRetry(plan, previous, next, [previous]).reasonCodes).toContain('RETRY_TIME_ROLLBACK')
    })
    it('rejects retry occurredAt before completedAt', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002'), completedAt: plan.plannedAt + 200, occurredAt: plan.plannedAt + 100 })
      expect(validateRetry(plan, previous, next, [previous]).valid).toBe(false)
    })
    it('rejects missing previous history for attempt two previous', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 3, executorRunId: opaque('ref-run-003') })
      expect(validateRetry(plan, previous, next).valid).toBe(false)
    })
    it('rejects invalid plan before retry work', () => {
      const plan = clone(makePlan())
      plan.planFingerprint = 'f'.repeat(64)
      const previous = receiptFor(makePlan(), 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(makePlan(), 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(validateRetry(plan, previous, next, [previous]).reasonCodes[0]).toBe('PLAN_INVALID')
    })
    it('rejects malformed history without throwing', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(() => validateRetry(plan, previous, next, [null])).not.toThrow()
      expect(validateRetry(plan, previous, next, [null]).valid).toBe(false)
    })
    it('rejects malformed previous without throwing', () => {
      expect(() => validateRetry(makePlan(), null, null)).not.toThrow()
    })
    it('rejects malformed next without throwing', () => {
      const plan = makePlan()
      const previous = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      expect(validateRetry(plan, previous, null, [previous]).valid).toBe(false)
    })
  })

  describe('receipt-backed route event ledger', () => {
    it('validates the plan in the ledger constructor', () => {
      const forged = clone(makePlan())
      forged.planFingerprint = 'f'.repeat(64)
      expect(() => new RouteEventLedger(forged)).toThrow(/invalid routing plan/)
    })
    it('rejects null plan in constructor', () => {
      expect(() => new RouteEventLedger(null)).toThrow(/invalid routing plan/)
    })
    it('accepts planned event as sequence one', () => {
      const plan = makePlan()
      expect(new RouteEventLedger(plan).append(makeEvent(plan))).toMatchObject({ accepted: true, replay: false })
    })
    it('requires sequence one for planned event', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), sequence: 2 })).toMatchObject({ accepted: false })
    })
    it('requires planned event attempt null', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), attempt: 1 })).toMatchObject({ accepted: false })
    })
    it('requires planned event executorRunId null', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), executorRunId: opaque('ref-run') })).toMatchObject({ accepted: false })
    })
    it('requires planned event receiptFingerprint null', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), receiptFingerprint: 'f'.repeat(64) })).toMatchObject({ accepted: false })
    })
    it('rejects planned event with receipt', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append(makeEvent(plan), receiptFor(plan))).toMatchObject({ accepted: false })
    })
    it('requires result event receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      expect(ledger.append(makeEvent(plan, route(plan), 2, 'delivered'))).toMatchObject({ accepted: false })
    })
    it('accepts delivered event with delivered receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'delivered' })
      expect(ledger.append(makeResultEvent(plan, receipt), receipt)).toMatchObject({ accepted: true })
    })
    it('accepts blocked event with blocked receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'blocked' })
      expect(ledger.append(makeResultEvent(plan, receipt), receipt)).toMatchObject({ accepted: true })
    })
    it('accepts failed event with failed receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'failed' })
      expect(ledger.append(makeResultEvent(plan, receipt), receipt)).toMatchObject({ accepted: true })
    })
    it('accepts retry_wait event with retry_wait receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'retry_wait' })
      expect(ledger.append(makeResultEvent(plan, receipt), receipt)).toMatchObject({ accepted: true })
    })
    it('rejects delivered event with failed receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'failed' })
      const event = makeResultEvent(plan, receipt, 2, { kind: 'delivered' })
      expect(ledger.append(event, receipt)).toMatchObject({ accepted: false })
    })
    it('rejects event receipt fingerprint mismatch', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      const event = makeResultEvent(plan, receipt, 2, { receiptFingerprint: 'f'.repeat(64) })
      expect(ledger.append(event, receipt)).toMatchObject({ accepted: false })
    })
    it('rejects event route mismatch', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      const ledger = plannedThenLedger(plan, 0)
      const receipt = receiptFor(plan, 1, { status: 'delivered' })
      const event = makeResultEvent(plan, receipt, 2, { routeId: route(plan, 0).routeId })
      expect(ledger.append(event, receipt)).toMatchObject({ accepted: false })
    })
    it('rejects event attempt mismatch', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      const event = makeResultEvent(plan, receipt, 2, { attempt: 2 })
      expect(ledger.append(event, receipt)).toMatchObject({ accepted: false })
    })
    it('rejects result event without valid receipt', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { contentHash: 'c'.repeat(64) })
      expect(ledger.append(makeResultEvent(plan, receipt), receipt)).toMatchObject({ accepted: false })
    })
    it('rejects result event before planned event', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      const receipt = receiptFor(plan)
      expect(ledger.append(makeResultEvent(plan, receipt), receipt)).toMatchObject({ accepted: false })
    })
    it('rejects event before plan time', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), occurredAt: plan.plannedAt - 1 })).toMatchObject({ accepted: false })
    })
    it('rejects timestamp rollback', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append(makeEvent(plan, route(plan), 1, 'planned', undefined, { occurredAt: plan.plannedAt + 20 }))).toMatchObject({ accepted: true })
      const receipt = receiptFor(plan, 0, { occurredAt: plan.plannedAt + 10, completedAt: plan.plannedAt + 10 })
      expect(ledger.append(makeResultEvent(plan, receipt, 2), receipt)).toMatchObject({ accepted: false })
    })
    it('accepts contiguous sequence', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      expect(ledger.append(makeResultEvent(plan, receipt, 2), receipt)).toMatchObject({ accepted: true })
    })
    it('rejects sequence gap', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      expect(ledger.append(makeResultEvent(plan, receipt, 3), receipt)).toMatchObject({ accepted: false })
    })
    it('rejects stale sequence', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      ledger.append(makeResultEvent(plan, receipt, 2), receipt)
      expect(ledger.append({ ...makeEvent(plan), detail: 'stale' })).toMatchObject({ accepted: false })
    })
    it('replays exact duplicate event', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      const event = makeResultEvent(plan, receipt, 2)
      ledger.append(event, receipt)
      expect(ledger.append(event, receipt)).toMatchObject({ accepted: true, replay: true, collision: false })
    })
    it('marks same sequence different payload as collision true', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      const event = makeResultEvent(plan, receipt, 2)
      ledger.append(event, receipt)
      const changed = { ...event, detail: 'changed' }
      expect(ledger.append(changed, receipt)).toMatchObject({ accepted: false, replay: false, collision: true })
    })
    it('rejects duplicate event fingerprint at another sequence', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan)
      const event = makeResultEvent(plan, receipt, 2)
      ledger.append(event, receipt)
      expect(ledger.append({ ...event, sequence: 3 }, receipt)).toMatchObject({ accepted: false })
    })
    it('rejects unknown event field', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), extra: true })).toMatchObject({ accepted: false })
    })
    it('rejects event detail over 1000 characters', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), detail: 'a'.repeat(1001) })).toMatchObject({ accepted: false })
    })
    it('rejects event detail control character', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), detail: 'bad\u0000detail' })).toMatchObject({ accepted: false })
    })
    it('rejects event detail surrounding whitespace', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(ledger.append({ ...makeEvent(plan), detail: ' detail' })).toMatchObject({ accepted: false })
    })
    it('makes delivered terminal', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'delivered' })
      ledger.append(makeResultEvent(plan, receipt, 2), receipt)
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(ledger.append(makeResultEvent(plan, next, 3), next)).toMatchObject({ accepted: false })
    })
    it('makes blocked terminal', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'blocked' })
      ledger.append(makeResultEvent(plan, receipt, 2), receipt)
      const next = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-002') })
      expect(ledger.append(makeResultEvent(plan, next, 3), next)).toMatchObject({ accepted: false })
    })
    it('accepts failed then retry_wait with attempt two', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const first = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      ledger.append(makeResultEvent(plan, first, 2), first)
      const second = receiptFor(plan, 0, { status: 'retry_wait', attempt: 2, executorRunId: opaque('ref-run-002'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
      expect(ledger.append(makeResultEvent(plan, second, 3), second)).toMatchObject({ accepted: true })
    })
    it('rejects failed then retry with reused run ID', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const first = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-run-001') })
      ledger.append(makeResultEvent(plan, first, 2), first)
      const second = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-run-001'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
      expect(ledger.append(makeResultEvent(plan, second, 3), second)).toMatchObject({ accepted: false })
    })
    it('aggregates separate result statuses', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'failed' })
      ledger.append(makeResultEvent(plan, receipt, 2), receipt)
      expect(ledger.aggregateRoute(route(plan).routeId)).toMatchObject({ failed: 1, delivered: 0, blocked: 0, retryWait: 0, status: 'failed' })
    })
    it('keeps delivered route count separate', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      const receipt = receiptFor(plan, 0, { status: 'delivered' })
      ledger.append(makeResultEvent(plan, receipt, 2), receipt)
      expect(ledger.aggregateRoute(route(plan).routeId)).toMatchObject({ delivered: 1, failed: 0 })
    })
    it('does not mark all targets delivered after one target', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      const ledger = plannedThenLedger(plan, 0)
      const receipt = receiptFor(plan, 0, { status: 'delivered' })
      ledger.append(makeResultEvent(plan, receipt, 2), receipt)
      expect(ledger.aggregate().overall).toBe('partial')
      expect(ledger.aggregate().routes[1]!.status).toBe('planned')
    })
    it('keeps blocked and delivered multi-target outcomes separate', () => {
      const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
      const ledger = new RouteEventLedger(plan)
      ledger.append(makeEvent(plan, route(plan, 0)))
      const blocked = receiptFor(plan, 0, { status: 'blocked' })
      ledger.append(makeResultEvent(plan, blocked, 2), blocked)
      ledger.append(makeEvent(plan, route(plan, 1)))
      const delivered = receiptFor(plan, 1, { status: 'delivered' })
      ledger.append(makeResultEvent(plan, delivered, 2), delivered)
      expect(ledger.aggregate().routes.map((entry) => entry.status)).toEqual(['blocked', 'delivered'])
    })
    it('returns route-scoped event copies', () => {
      const plan = makePlan()
      const ledger = plannedThenLedger(plan)
      expect(ledger.eventsFor(route(plan).routeId)).toHaveLength(1)
      expect(ledger.eventsFor(route(plan).routeId)).not.toBe(ledger.eventsFor(route(plan).routeId))
    })
    it('handles event getter exception without throwing', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(() => ledger.append({ get planFingerprint(): string { throw new Error('getter') } })).not.toThrow()
    })
    it('handles event Proxy exception without throwing', () => {
      const plan = makePlan()
      const ledger = new RouteEventLedger(plan)
      expect(() => ledger.append(new Proxy({}, { get(): never { throw new Error('proxy') } }))).not.toThrow()
    })
    it('aggregateEvents rejects invalid result without receipt', () => {
      const plan = makePlan()
      expect(() => aggregateEvents(plan, [makeEvent(plan), makeEvent(plan, route(plan), 2, 'delivered')])).toThrow(/EVENT_RECEIPT_MISSING|RESULT_EVENT_RECEIPT_REQUIRED|RECEIPT_REQUIRED/)
    })
    it('aggregateEvents accepts planned event list', () => {
      const plan = makePlan()
      expect(aggregateEvents(plan, [makeEvent(plan)]).overall).toBe('planned')
    })
  })

  describe('illegal matrix cross-products and malformed runtime inputs', () => {
    const invalidCombinations = [
      ['astro', 'wordpress_rest'],
      ['astro', 'geoflow_agent'],
      ['astro', 'generic_http'],
      ['astro', 'geoflow_local'],
      ['nuxt', 'wordpress_rest'],
      ['nuxt', 'geoflow_agent'],
      ['nuxt', 'generic_http'],
      ['wordpress', 'first_party_git'],
      ['wordpress', 'first_party_signed_api'],
      ['wordpress', 'generic_http'],
      ['php_agent', 'wordpress_rest'],
      ['php_agent', 'generic_http'],
      ['generic_http', 'geoflow_agent'],
      ['generic_http', 'geoflow_local'],
      ['geoflow_local', 'generic_http'],
      ['static_site', 'first_party_git'],
      ['static_site', 'wordpress_rest'],
      ['static_site', 'generic_http'],
    ] as const
    it.each(invalidCombinations)('rejects illegal %s/%s', (framework, transport) => {
      expect(() => makePlan([makeTarget({ framework: framework as PublicationTargetInput['framework'], transport: transport as PublicationTargetInput['transport'] })])).toThrow(/unsupported capability/)
    })
    it('rejects null create input', () => {
      expect(() => createRoutingPlan(null as unknown as CreateRoutingPlanInput)).toThrow(/input/)
    })
    it('rejects array create input', () => {
      expect(() => createRoutingPlan([] as unknown as CreateRoutingPlanInput)).toThrow(/input/)
    })
    it('rejects null targets collection', () => {
      expect(() => createRoutingPlan({ ...makeInput(), targets: null as never })).toThrow(/input|targets/)
    })
    it('rejects null target entry', () => {
      expect(() => makePlan([null as never])).toThrow(/target/)
    })
    it('rejects null draft', () => {
      expect(() => createRoutingPlan({ ...makeInput(), draft: null as never })).toThrow(/draft/)
    })
    it('rejects null target ID', () => {
      expect(() => makePlan([makeTarget({ targetId: null as never })])).toThrow(/targetId/)
    })
    it('rejects numeric target ID', () => {
      expect(() => makePlan([makeTarget({ targetId: 123 as never })])).toThrow(/targetId/)
    })
    it('rejects empty site identity', () => {
      expect(() => makePlan([makeTarget({ siteIdentity: '' })])).toThrow(/siteIdentity/)
    })
    it('rejects numeric destination identity', () => {
      expect(() => makePlan([makeTarget({ destinationPublicationIdentity: 123 as never })])).toThrow(/destinationPublicationIdentity/)
    })
    it('rejects target with getter exception', () => {
      const target = new Proxy({}, { get(): never { throw new Error('target getter') } }) as PublicationTargetInput
      expect(() => makePlan([target])).toThrow(/target/)
    })
    it('rejects target with symbol key', () => {
      const target = { ...makeTarget(), [Symbol('extra')]: true }
      expect(() => makePlan([target])).toThrow(/target/)
    })
    it('rejects target class instance', () => {
      class Target { constructor(readonly value: PublicationTargetInput) {} }
      expect(() => makePlan([new Target(makeTarget()) as never])).toThrow(/target/)
    })
    it('rejects draft extra field', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: { ...makeDraft(), extra: true } as never })).toThrow(/draft/)
    })
    it('rejects draft symbol key', () => {
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: { ...makeDraft(), [Symbol('extra')]: true } as never })).toThrow(/draft/)
    })
    it('rejects draft getter exception', () => {
      const draft = new Proxy(makeDraft(), { get(_target, property) { if (property === 'contentHash') throw new Error('getter'); return Reflect.get(_target, property) } })
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft })).toThrow(/draft|contentHash|getter/)
    })
    it('rejects circular draft', () => {
      const draft = { ...makeDraft() } as Record<string, unknown>
      draft.circular = draft
      expect(() => makePlan([LEGAL_TARGETS.astroGit], { draft: draft as never })).toThrow(/draft/)
    })
    it('rejects route URL as credential reference', () => {
      expect(() => makePlan([makeTarget({ credentialReference: 'https://credential.routing.discoverystack.dev' })])).toThrow(/credentialReference/)
    })
    it('rejects local target caller URL', () => {
      expect(() => makePlan([makeTarget({ framework: 'geoflow_local', transport: 'geoflow_local', targetUrl: 'https://public.routing.discoverystack.dev', serviceReference: 'ref-service-local-001' })])).toThrow(/caller URL|GEOFLOW_LOCAL_CALLER_URL/ )
    })
    it('rejects undefined local URL field', () => {
      expect(() => makePlan([makeTarget({ framework: 'geoflow_local', transport: 'geoflow_local', targetUrl: undefined as never, serviceReference: 'ref-service-local-001' })])).toThrow(/target/)
    })
    it('rejects undefined local service field', () => {
      expect(() => makePlan([makeTarget({ framework: 'geoflow_local', transport: 'geoflow_local', targetUrl: null, serviceReference: undefined as never })])).toThrow(/target|serviceReference/)
    })
    it('keeps fixture timestamp deterministic', () => {
      expect(makePlan().plannedAt).toBe(FIXTURE_NOW)
    })
    it('keeps fixture source SHA deterministic', () => {
      expect(makePlan().metadata.geoflowSourceSha).toBe(GEOFlow_PINNED_SOURCE_SHA)
    })
  })
})


describe('Third-round Codex reproduction cases', () => {
  it('accepts multiline Markdown with headings, paragraphs, FAQ, fenced code, CJK, emoji and tabs', () => {
    const markdown = '# 標題\n\n段落與 FAQ：什麼是路由？\n\n```ts\n\tconst answer = "答案"\n```\n\n結尾 😀\n'
    expect(normalizeMarkdownContent(markdown)).toBe(markdown)
    const plan = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content: markdown }) })
    expect(plan.metadata.contentHash).toBe(sha256Hex(markdown))
  })

  it('rejects CRLF and standalone CR Markdown content', () => {
    expect(() => normalizeMarkdownContent('# title\r\nparagraph')).toThrow(/control/)
    expect(() => normalizeMarkdownContent('# title\rparagraph')).toThrow(/control/)
  })

  it('rejects Markdown NUL and unpaired surrogate content', () => {
    expect(() => normalizeMarkdownContent('valid\u0000content')).toThrow(/control/)
    expect(() => normalizeMarkdownContent(`valid${String.fromCharCode(0xd800)}content`)).toThrow(/surrogate/)
  })

  it('preserves exact Markdown bytes and changes plan fingerprint when one LF changes', () => {
    const first = '# title\n\nparagraph'
    const second = '# title\nparagraph'
    const firstPlan = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content: first }) })
    const secondPlan = makePlan([LEGAL_TARGETS.astroGit], { draft: makeDraft({ content: second }) })
    expect(firstPlan.metadata.contentHash).toBe(sha256Hex(first))
    expect(firstPlan.metadata.contentHash).not.toBe(sha256Hex(second))
    expect(firstPlan.planFingerprint).not.toBe(secondPlan.planFingerprint)
  })

  it('rejects unknown planned route before ledger map admission', () => {
    const plan = makePlan()
    const ledger = new RouteEventLedger(plan)
    const result = ledger.append({ ...makeEvent(plan), routeId: 'route_unknown' })
    expect(result).toMatchObject({ accepted: false, reasonCodes: ['EVENT_ROUTE_UNKNOWN'] })
    expect(ledger.eventsFor('route_unknown')).toEqual([])
  })

  it('rejects unknown result route', () => {
    const plan = makePlan()
    const ledger = new RouteEventLedger(plan)
    const receipt = receiptFor(plan)
    const result = ledger.append({ ...makeResultEvent(plan, receipt), routeId: 'route_unknown' }, receipt)
    expect(result).toMatchObject({ accepted: false, reasonCodes: ['EVENT_ROUTE_UNKNOWN'] })
  })

  it('rejects a result event as sequence one and without planned event', () => {
    const plan = makePlan()
    const ledger = new RouteEventLedger(plan)
    const receipt = receiptFor(plan)
    expect(ledger.append(makeResultEvent(plan, receipt, 1), receipt)).toMatchObject({ accepted: false, reasonCodes: ['EVENT_PLANNED_REQUIRED'] })
    expect(ledger.append(makeResultEvent(plan, receipt, 2), receipt)).toMatchObject({ accepted: false, reasonCodes: ['EVENT_PLANNED_REQUIRED'] })
  })

  it('rejects planned sequence two and a second planned event', () => {
    const plan = makePlan()
    const ledger = new RouteEventLedger(plan)
    expect(ledger.append({ ...makeEvent(plan), sequence: 2 })).toMatchObject({ accepted: false })
    expect(ledger.append(makeEvent(plan))).toMatchObject({ accepted: true })
    expect(ledger.append(makeEvent(plan))).toMatchObject({ accepted: true, replay: true })
    expect(ledger.append({ ...makeEvent(plan), detail: 'second planned' })).toMatchObject({ accepted: false, collision: true })
  })

  it('does not let one route planned event unlock another route result', () => {
    const plan = makePlan([LEGAL_TARGETS.astroGit, LEGAL_TARGETS.wordpress])
    const ledger = new RouteEventLedger(plan)
    ledger.append(makeEvent(plan, route(plan, 0)))
    const receipt = receiptFor(plan, 1)
    const result = ledger.append(makeResultEvent(plan, receipt, 2), receipt)
    expect(result).toMatchObject({ accepted: false, reasonCodes: ['EVENT_PLANNED_REQUIRED'] })
  })

  it('requires exact event and receipt occurredAt equality', () => {
    const plan = makePlan()
    const ledger = plannedThenLedger(plan)
    const receipt = receiptFor(plan, 0, { occurredAt: plan.plannedAt + 200 })
    expect(ledger.append(makeResultEvent(plan, receipt, 2, { occurredAt: receipt.occurredAt + 1 }), receipt)).toMatchObject({ accepted: false, reasonCodes: ['EVENT_RECEIPT_TIMESTAMP_MISMATCH'] })
    expect(ledger.append(makeResultEvent(plan, receipt, 2, { occurredAt: receipt.occurredAt - 1 }), receipt)).toMatchObject({ accepted: false, reasonCodes: ['EVENT_RECEIPT_TIMESTAMP_MISMATCH'] })
    expect(ledger.append(makeResultEvent(plan, receipt, 2), receipt)).toMatchObject({ accepted: true })
  })

  it('does not expose mutable event references through append result or eventsFor', () => {
    const plan = makePlan()
    const ledger = new RouteEventLedger(plan)
    const planned = makeEvent(plan)
    const acceptedResult = ledger.append(planned)
    const returned = acceptedResult.events[0] as any
    returned.kind = 'failed'
    ;(planned as any).kind = 'failed'
    expect(ledger.eventsFor(route(plan).routeId)[0]!.kind).toBe('planned')
    const listed = ledger.eventsFor(route(plan).routeId)[0] as any
    listed.kind = 'failed'
    expect(ledger.eventsFor(route(plan).routeId)[0]!.kind).toBe('planned')
  })

  it('does not preserve caller receipt mutation in ledger retry history', () => {
    const plan = makePlan()
    const ledger = plannedThenLedger(plan)
    const callerReceipt = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-caller-run-001') })
    const callerEvent = makeResultEvent(plan, callerReceipt, 2)
    expect(ledger.append(callerEvent, callerReceipt)).toMatchObject({ accepted: true })
    const mutableCallerReceipt = callerReceipt as any
    mutableCallerReceipt.status = 'delivered'
    mutableCallerReceipt.occurredAt = plan.plannedAt - 1
    ;(callerEvent as any).kind = 'delivered'
    const next = receiptFor(plan, 0, { status: 'delivered', attempt: 2, executorRunId: opaque('ref-caller-run-002'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
    expect(ledger.append(makeResultEvent(plan, next, 3), next)).toMatchObject({ accepted: true })
  })

  it('rejects retry completedAt rollback in validateReceiptHistory and validateRetry', () => {
    const plan = makePlan()
    const first = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-time-run-001'), completedAt: plan.plannedAt + 100, occurredAt: plan.plannedAt + 200 })
    const second = receiptFor(plan, 0, { status: 'delivered', attempt: 2, executorRunId: opaque('ref-time-run-002'), completedAt: plan.plannedAt + 199, occurredAt: plan.plannedAt + 300 })
    expect(validateReceiptHistory(plan, [second, first]).valid).toBe(false)
    expect(validateRetry(plan, first, second, [first]).valid).toBe(false)
  })

  it('accepts unordered valid receipt history deterministically', () => {
    const plan = makePlan()
    const first = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-order-run-001') })
    const second = receiptFor(plan, 0, { status: 'delivered', attempt: 2, executorRunId: opaque('ref-order-run-002'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
    const ordered = validateReceiptHistory(plan, [first, second])
    const unordered = validateReceiptHistory(plan, [second, first])
    expect(ordered.valid).toBe(true)
    expect(unordered.valid).toBe(true)
    expect(ordered.receipts.map((receipt) => fingerprint(receipt))).toEqual(unordered.receipts.map((receipt) => fingerprint(receipt)))
  })

  it('rejects stale attempt one as retry previous when attempt two is latest', () => {
    const plan = makePlan()
    const first = receiptFor(plan, 0, { status: 'failed', executorRunId: opaque('ref-stale-run-001') })
    const second = receiptFor(plan, 0, { status: 'failed', attempt: 2, executorRunId: opaque('ref-stale-run-002'), completedAt: plan.plannedAt + 300, occurredAt: plan.plannedAt + 400 })
    const third = receiptFor(plan, 0, { status: 'delivered', attempt: 3, executorRunId: opaque('ref-stale-run-003'), completedAt: plan.plannedAt + 500, occurredAt: plan.plannedAt + 600 })
    expect(validateRetry(plan, first, third, [first, second]).reasonCodes).toContain('RETRY_PREVIOUS_NOT_LATEST')
  })

  it('keeps projection credentialReference and validates it immutably', () => {
    const plan = makePlan([LEGAL_TARGETS.astroGit])
    const projection = projectFirstParty(plan)[0]!
    expect(projection.credentialReference).toBe('ref-github-app-123')
    expect(Object.isFrozen(projection)).toBe(true)
    expect(validateProjectionIntent(plan, projection)).toMatchObject({ valid: true })
    const forged = { ...projection, credentialReference: 'ref-other-credential' }
    expect(validateProjectionIntent(plan, forged).valid).toBe(false)
  })

  it('keeps GEOFlow local serviceReference and credentialReference', () => {
    const plan = makePlan([LEGAL_TARGETS.geoflowLocal])
    const projection = projectGeoflow(plan)[0]!
    expect(projection.serviceReference).toBe('ref-service-local-001')
    expect(projection.credentialReference).toBe('ref-local-service-001')
    expect(validateProjectionIntent(plan, projection).valid).toBe(true)
  })

  it('rejects mutated projection route, target, executor, authority and extra field', () => {
    const plan = makePlan()
    const projection = projectFirstParty(plan)[0]!
    for (const mutation of [
      { routeId: 'route-forged' },
      { targetUrl: 'https://public.routing.discoverystack.dev/forged' },
      { executor: 'wordpress_rest' },
      { executorAuthority: 'geoflow_content_engine' },
      { extra: true },
    ]) {
      expect(validateProjectionIntent(plan, { ...projection, ...mutation }).valid).toBe(false)
    }
  })

  it('aggregateEvents requires one-to-one receipts and rejects unused/missing receipts', () => {
    const plan = makePlan()
    const planned = makeEvent(plan)
    const receipt = receiptFor(plan)
    const resultEvent = makeResultEvent(plan, receipt, 2)
    expect(aggregateEvents(plan, [planned, resultEvent], [receipt]).overall).toBe('delivered')
    expect(() => aggregateEvents(plan, [planned, resultEvent], [])).toThrow(/EVENT_RECEIPT_MISSING/)
    expect(() => aggregateEvents(plan, [planned], [receipt])).toThrow(/EVENT_RECEIPT_UNUSED/)
  })

  it('aggregateEvents rejects another-plan, another-route and conflicting duplicate receipts', () => {
    const plan = makePlan()
    const otherPlan = makePlan([LEGAL_TARGETS.nuxtGit])
    const planned = makeEvent(plan)
    const receipt = receiptFor(plan)
    const resultEvent = makeResultEvent(plan, receipt, 2)
    expect(() => aggregateEvents(plan, [planned, resultEvent], [receipt, receiptFor(otherPlan)])).toThrow(/RECEIPT_PLAN_FINGERPRINT_INVALID|EVENT_RECEIPT_UNUSED/)
    const conflicting = receiptFor(plan, 0, { occurredAt: plan.plannedAt + 201, completedAt: plan.plannedAt + 101 })
    expect(() => aggregateEvents(plan, [planned, resultEvent], [receipt, conflicting])).toThrow(/RECEIPT_ATTEMPT_COLLISION/)
  })
})
