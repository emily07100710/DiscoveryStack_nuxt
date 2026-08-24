import { describe, expect, it } from 'vitest'
import {
  AUTHORITY_POLICY_LIMITATIONS,
  AUTHORITY_POLICY_VERSION,
  authorityDecisionStatuses,
  authorityPurposes,
  authoritySourceHash,
  authoritySourceTypes,
  canonicalAuthoritySourcePayload,
  evaluateAuthoritySource,
  normalizeAuthoritySourceCandidate,
  normalizeAuthoritySourceUrl,
  selectAuthoritySources,
} from '../server/authority-intelligence'
import {
  AUTHORITY_AS_OF,
  makeAuthorityRequest,
  makeAuthoritySource,
  makeSelectionRequest,
  syntheticAuthoritySources,
} from './fixtures/authority-intelligence/sources'

const withoutHash = (candidate: ReturnType<typeof makeAuthoritySource>) => {
  const { sourceHash: _ignored, ...payload } = candidate
  return payload
}

const decisionFor = (candidate: ReturnType<typeof makeAuthoritySource>, overrides: Partial<ReturnType<typeof makeAuthorityRequest>> = {}) => evaluateAuthoritySource({ ...makeAuthorityRequest({ candidate }), ...overrides, candidate })

function sourceSetForTiers() {
  return [
    makeAuthoritySource({ sourceId: 'weak-001', sourceName: 'Synthetic Community', sourceUrl: 'https://community.synthetic.example.org/one', publisherDomain: 'community.synthetic.example.org', sourceType: 'community', termsStatus: 'allows_citation' }),
    makeAuthoritySource({ sourceId: 'primary-002', sourceName: 'Synthetic Government', sourceUrl: 'https://gov.synthetic.example.org/two', publisherDomain: 'gov.synthetic.example.org', sourceType: 'government' }),
    makeAuthoritySource({ sourceId: 'contextual-001', sourceName: 'Synthetic Industry Publication', sourceUrl: 'https://industry.synthetic.example.org/three', publisherDomain: 'industry.synthetic.example.org', sourceType: 'industry_publication' }),
    makeAuthoritySource({ sourceId: 'high-001', sourceName: 'Synthetic Association', sourceUrl: 'https://association.synthetic.example.org/four', publisherDomain: 'association.synthetic.example.org', sourceType: 'professional_association' }),
  ]
}

describe('Authority Source Policy Engine V1 contract', () => {
  it('exports the fixed source types, purposes, statuses, and policy version', () => {
    expect(authoritySourceTypes).toHaveLength(12)
    expect(authorityPurposes).toEqual(['research_reference', 'content_citation', 'evidence_support', 'model_evaluation', 'model_training'])
    expect(authorityDecisionStatuses).toEqual(['approved', 'review_required', 'not_ready', 'blocked'])
    expect(AUTHORITY_POLICY_VERSION).toBe('authority-source-policy-v1')
  })

  it('produces a deterministic canonical payload and hash', () => {
    const candidate = syntheticAuthoritySources.government
    expect(canonicalAuthoritySourcePayload(withoutHash(candidate))).toEqual(canonicalAuthoritySourcePayload(withoutHash(candidate)))
    expect(authoritySourceHash(withoutHash(candidate))).toBe(candidate.sourceHash)
    expect(authoritySourceHash(withoutHash(candidate))).toBe(authoritySourceHash(withoutHash(candidate)))
  })

  it('makes array order irrelevant to the canonical hash', () => {
    const candidate = syntheticAuthoritySources.government
    const reordered = makeAuthoritySource({ sectors: [...candidate.sectors].reverse(), topics: [...candidate.topics].reverse() })
    expect(reordered.sourceHash).toBe(candidate.sourceHash)
  })

  it('blocks metadata tampering when the source hash is unchanged', () => {
    const candidate = { ...syntheticAuthoritySources.government, title: 'Tampered title' }
    const decision = decisionFor(candidate)
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('SOURCE_HASH_MISMATCH')
  })

  it('normalizes an uppercase source hash before validation', () => {
    const candidate = { ...syntheticAuthoritySources.government, sourceHash: syntheticAuthoritySources.government.sourceHash.toUpperCase() }
    expect(decisionFor(candidate).status).toBe('approved')
    expect(decisionFor(candidate).sourceHash).toBe(syntheticAuthoritySources.government.sourceHash)
  })

  it('rejects a non-64-hex source hash', () => {
    const decision = decisionFor({ ...syntheticAuthoritySources.government, sourceHash: 'not-a-hash' })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_HASH')
  })

  it('normalizes NFKC text and collapses whitespace', () => {
    const normalized = normalizeAuthoritySourceCandidate(makeAuthoritySource({ sourceName: '  Ｓｙｎｔｈｅｔｉｃ\u00a0 Office  ', title: '  A   title  ' }))
    expect(normalized?.sourceName).toBe('Synthetic Office')
    expect(normalized?.title).toBe('A title')
  })

  it('normalizes sectors and topics by lowercase, deduplication, and stable sort', () => {
    const normalized = normalizeAuthoritySourceCandidate(makeAuthoritySource({ sectors: ['Healthcare', 'healthcare', ' Public Policy '], topics: ['Z topic', 'a topic', 'A Topic'] }))
    expect(normalized?.sectors).toEqual(['healthcare', 'public policy'])
    expect(normalized?.topics).toEqual(['a topic', 'z topic'])
  })

  it('removes URL fragments and normalizes the default HTTPS port', () => {
    expect(normalizeAuthoritySourceUrl(' https://standards.synthetic.example.org:443/path#fragment ')).toBe('https://standards.synthetic.example.org/path')
  })

  it('rejects credential-bearing URLs', () => {
    const decision = decisionFor(makeAuthoritySource({ sourceUrl: 'https://user:password@standards.synthetic.example.org/item' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_URL')
  })

  it('rejects HTTP URLs', () => {
    const decision = decisionFor(makeAuthoritySource({ sourceUrl: 'http://standards.synthetic.example.org/item' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_URL')
  })

  it('rejects localhost URLs', () => {
    const decision = decisionFor(makeAuthoritySource({ sourceUrl: 'https://localhost/item', publisherDomain: 'localhost' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_URL')
  })

  it('rejects private IPv4 URLs', () => {
    const decision = decisionFor(makeAuthoritySource({ sourceUrl: 'https://192.168.1.10/item', publisherDomain: '192.168.1.10' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_URL')
  })

  it('rejects loopback IPv6 URLs', () => {
    const decision = decisionFor(makeAuthoritySource({ sourceUrl: 'https://[::1]/item', publisherDomain: '::1' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_URL')
  })

  it('rejects reserved hostnames', () => {
    const decision = decisionFor(makeAuthoritySource({ sourceUrl: 'https://source.invalid/item', publisherDomain: 'source.invalid' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_SOURCE_URL')
  })

  it('blocks publisher domain mismatch', () => {
    const decision = decisionFor(makeAuthoritySource({ publisherDomain: 'different.synthetic.example.org' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('SOURCE_DOMAIN_MISMATCH')
  })

  it('normalizes offset dates to UTC', () => {
    const candidate = makeAuthoritySource({
      publishedAt: '2024-12-01T08:00:00+08:00',
      updatedAt: '2025-01-01T08:00:00+08:00',
      capturedAt: '2025-01-09T08:00:00+08:00',
    })
    const normalized = normalizeAuthoritySourceCandidate(candidate)
    expect(normalized?.publishedAt).toBe('2024-12-01T00:00:00.000Z')
    expect(normalized?.capturedAt).toBe('2025-01-09T00:00:00.000Z')
  })

  it('rejects a date without timezone', () => {
    const decision = decisionFor(makeAuthoritySource({ capturedAt: '2025-01-09T00:00:00' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_INPUT')
  })

  it('rejects dates in the wrong order', () => {
    const decision = decisionFor(makeAuthoritySource({ publishedAt: '2025-01-02T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_INPUT')
  })

  it.each([null, undefined, 'bad root', [], 42])('fails closed for malformed root input %# without throwing', (input) => {
    expect(() => evaluateAuthoritySource(input)).not.toThrow()
    expect(evaluateAuthoritySource(input).status).toBe('blocked')
    expect(evaluateAuthoritySource(input).reasonCodes).toContain('INVALID_INPUT')
  })

  it('approves a relevant technical arXiv research reference under complete governance', () => {
    const candidate = syntheticAuthoritySources.preprint
    const decision = decisionFor(candidate, { purpose: 'research_reference', clientSector: 'technology', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.status).toBe('approved')
    expect(decision.authorityTier).toBe('contextual')
    expect(decision.matchedTopics).toEqual(['machine learning'])
  })

  it('retains the preprint limitation for arXiv', () => {
    const decision = decisionFor(syntheticAuthoritySources.preprint, { purpose: 'research_reference', clientSector: 'technology', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.limitations).toContain('preprint_not_peer_reviewed')
  })

  it('does not label arXiv as peer reviewed', () => {
    const decision = decisionFor(syntheticAuthoritySources.preprint, { purpose: 'research_reference', clientSector: 'technology', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.authorityTier).not.toBe('primary')
    expect(decision.limitations).not.toContain('peer_reviewed')
  })

  it('blocks an arXiv preprint without sector or topic relevance', () => {
    const decision = decisionFor(syntheticAuthoritySources.preprint, { purpose: 'research_reference', clientSector: 'healthcare', contentTopics: ['unrelated topic'], targetJurisdiction: null })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('NO_RELEVANCE_MATCH')
  })

  it('requires expert review for a healthcare preprint used as evidence', () => {
    const decision = decisionFor(syntheticAuthoritySources.preprint, { purpose: 'evidence_support', clientSector: 'healthcare', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('PREPRINT_REQUIRES_EXPERT_REVIEW')
  })

  it('requires expert review for a legal preprint used for citation', () => {
    const candidate = makeAuthoritySource({ sourceId: 'legal-preprint', sourceName: 'Synthetic Legal Preprint', sourceUrl: 'https://arxiv.org/abs/1234.5678', publisherDomain: 'arxiv.org', sourceType: 'preprint_repository', title: 'Synthetic legal machine learning preprint', sectors: ['legal'], topics: ['machine learning'], termsStatus: 'allows_research' })
    const decision = decisionFor(candidate, { purpose: 'content_citation', clientSector: 'legal', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('PREPRINT_REQUIRES_EXPERT_REVIEW')
  })

  it('requires expert review for a finance preprint used as evidence', () => {
    const candidate = makeAuthoritySource({ sourceId: 'finance-preprint', sourceName: 'Synthetic Finance Preprint', sourceUrl: 'https://arxiv.org/abs/1234.5678', publisherDomain: 'arxiv.org', sourceType: 'preprint_repository', title: 'Synthetic finance machine learning preprint', sectors: ['finance'], topics: ['machine learning'], termsStatus: 'allows_research' })
    const decision = decisionFor(candidate, { purpose: 'evidence_support', clientSector: 'finance', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('PREPRINT_REQUIRES_EXPERT_REVIEW')
  })

  it.each([
    ['government', syntheticAuthoritySources.government],
    ['standards body', syntheticAuthoritySources.standards],
    ['peer reviewed paper', syntheticAuthoritySources.peerReviewed],
  ])('%s relevant source can be approved', (_label, candidate) => {
    expect(decisionFor(candidate).status).toBe('approved')
  })

  it.each([
    ['commercial blog', 'commercial_blog'],
    ['community', 'community'],
    ['social', 'social'],
  ] as const)('%s cannot be approved for evidence support', (_label, sourceType) => {
    const candidate = makeAuthoritySource({ sourceId: `${sourceType}-evidence`, sourceType, sourceUrl: `https://${sourceType}.synthetic.example.org/item`, publisherDomain: `${sourceType}.synthetic.example.org` })
    const decision = decisionFor(candidate, { purpose: 'evidence_support' })
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('WEAK_SOURCE_FOR_EVIDENCE')
  })

  it('requires review for unknown licence status', () => {
    const decision = decisionFor(makeAuthoritySource({ licenceStatus: 'unknown' }))
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('LICENCE_REVIEW_REQUIRED')
  })

  it('requires review for unknown terms status', () => {
    const decision = decisionFor(makeAuthoritySource({ termsStatus: 'unknown' }))
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('TERMS_REVIEW_REQUIRED')
  })

  it('blocks a copyright-blocked source', () => {
    const decision = decisionFor(makeAuthoritySource({ copyrightRisk: 'blocked' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('COPYRIGHT_BLOCKED')
  })

  it('requires review for high copyright risk', () => {
    const decision = decisionFor(makeAuthoritySource({ copyrightRisk: 'high' }))
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('COPYRIGHT_REVIEW_REQUIRED')
  })

  it('blocks restricted PII status', () => {
    const decision = decisionFor(makeAuthoritySource({ piiStatus: 'restricted' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('PII_RESTRICTED')
  })

  it('requires review for possible PII', () => {
    const decision = decisionFor(makeAuthoritySource({ piiStatus: 'possible' }))
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('PII_REVIEW_REQUIRED')
  })

  it('always blocks model training in V1', () => {
    const decision = decisionFor(syntheticAuthoritySources.government, { purpose: 'model_training' })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('MODEL_TRAINING_NOT_SUPPORTED_V1')
  })

  it('blocks prohibited automation in automated ingestion', () => {
    const decision = decisionFor(makeAuthoritySource({ termsStatus: 'prohibits_automation' }), { workflowMode: 'automated_ingestion' })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('AUTOMATION_PROHIBITED')
  })

  it('blocks robots restriction in automated ingestion', () => {
    const decision = decisionFor(makeAuthoritySource({ robotsStatus: 'reviewed_restrict' }), { workflowMode: 'automated_ingestion' })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('ROBOTS_RESTRICT_AUTOMATION')
  })

  it('does not treat robots restriction as automatic approval in manual review', () => {
    const decision = decisionFor(makeAuthoritySource({ robotsStatus: 'reviewed_restrict' }))
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('ROBOTS_REVIEW_REQUIRED')
  })

  it('requires jurisdiction review when citation jurisdiction differs', () => {
    const decision = decisionFor(makeAuthoritySource({ jurisdiction: 'us' }), { targetJurisdiction: 'ca' })
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('JURISDICTION_REVIEW_REQUIRED')
  })

  it('blocks a source with no sector and topic relevance', () => {
    const decision = decisionFor(makeAuthoritySource({ sectors: ['other'], topics: ['other'] }), { clientSector: 'healthcare', contentTopics: ['data governance'] })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('NO_RELEVANCE_MATCH')
  })

  it('returns stable authority tier ordering', () => {
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: sourceSetForTiers(), maxSelected: 10 }))
    expect(result.status).toBe('ready')
    expect(result.selected.map((item) => item.authorityTier)).toEqual(['primary', 'high', 'contextual', 'weak'])
  })

  it('returns stable ordering by matched topic count and sourceId within a tier', () => {
    const first = makeAuthoritySource({ sourceId: 'same-tier-b', sourceName: 'B', sourceUrl: 'https://b.synthetic.example.org/item', publisherDomain: 'b.synthetic.example.org', topics: ['data governance'] })
    const second = makeAuthoritySource({ sourceId: 'same-tier-a', sourceName: 'A', sourceUrl: 'https://a.synthetic.example.org/item', publisherDomain: 'a.synthetic.example.org', topics: ['data governance', 'synthetic testing'] })
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: [first, second], contentTopics: ['data governance', 'synthetic testing'], maxSelected: 10 }))
    expect(result.selected.map((item) => item.sourceId)).toEqual(['same-tier-a', 'same-tier-b'])
  })

  it('does not let candidate input order change selection or fingerprint', () => {
    const candidates = sourceSetForTiers()
    const left = selectAuthoritySources(makeSelectionRequest({ candidates, maxSelected: 3 }))
    const right = selectAuthoritySources(makeSelectionRequest({ candidates: [...candidates].reverse(), maxSelected: 3 }))
    expect(right).toEqual(left)
  })

  it('fails closed on duplicate normalized sourceId', () => {
    const first = makeAuthoritySource({ sourceId: 'duplicate-id', sourceUrl: 'https://first.synthetic.example.org/item', publisherDomain: 'first.synthetic.example.org' })
    const second = makeAuthoritySource({ sourceId: ' DUPLICATE-ID ', sourceUrl: 'https://second.synthetic.example.org/item', publisherDomain: 'second.synthetic.example.org', title: 'Second duplicate' })
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: [first, second], maxSelected: 10 }))
    expect(result.blocked.some((item) => item.reasonCodes.includes('DUPLICATE_SOURCE'))).toBe(true)
    expect(result.limitations).toContain('偵測到 duplicate sourceId 或 sourceHash；重複項目已 fail closed，未靜默覆蓋。')
  })

  it('fails closed on duplicate sourceHash', () => {
    const first = makeAuthoritySource({ sourceId: 'hash-first', sourceUrl: 'https://first-hash.synthetic.example.org/item', publisherDomain: 'first-hash.synthetic.example.org' })
    const second = makeAuthoritySource({ sourceId: 'hash-second', sourceUrl: 'https://second-hash.synthetic.example.org/item', publisherDomain: 'second-hash.synthetic.example.org', sourceHash: first.sourceHash })
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: [first, second], maxSelected: 10 }))
    expect(result.blocked.some((item) => item.reasonCodes.includes('DUPLICATE_SOURCE'))).toBe(true)
  })

  it('rejects maxSelected below one', () => {
    expect(selectAuthoritySources(makeSelectionRequest({ maxSelected: 0 })).status).toBe('rejected')
  })

  it('rejects maxSelected above ten', () => {
    expect(selectAuthoritySources(makeSelectionRequest({ maxSelected: 11 })).status).toBe('rejected')
  })

  it('limits selected approved sources to maxSelected', () => {
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: sourceSetForTiers(), maxSelected: 1 }))
    expect(result.selected).toHaveLength(1)
  })

  it('fails closed when more than 50 candidates are supplied', () => {
    const candidates = Array.from({ length: 51 }, (_, index) => makeAuthoritySource({ sourceId: `source-${String(index).padStart(2, '0')}`, sourceUrl: `https://source-${String(index).padStart(2, '0')}.synthetic.example.org/item`, publisherDomain: `source-${String(index).padStart(2, '0')}.synthetic.example.org` }))
    const result = selectAuthoritySources(makeSelectionRequest({ candidates, maxSelected: 10 }))
    expect(result.status).toBe('rejected')
    expect(result.selected).toHaveLength(0)
    expect(result.limitations).toContain('MAX_CANDIDATES_EXCEEDED')
  })

  it('does not fill selected with review-required sources', () => {
    const approved = syntheticAuthoritySources.government
    const review = makeAuthoritySource({ sourceId: 'review-only', sourceType: 'commercial_blog', sourceUrl: 'https://review.synthetic.example.org/item', publisherDomain: 'review.synthetic.example.org' })
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: [approved, review], purpose: 'evidence_support', maxSelected: 2 }))
    expect(result.selected.map((item) => item.sourceId)).toEqual([approved.sourceId])
    expect(result.reviewRequired.map((item) => item.sourceId)).toContain(review.sourceId)
    expect(result.status).toBe('not_ready')
  })

  it('does not expose truth or outcome prediction fields', () => {
    const decision = decisionFor(syntheticAuthoritySources.government)
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('truthScore')
    expect(serialized).not.toContain('rankingPrediction')
    expect(serialized).not.toContain('trafficPrediction')
    expect(serialized).not.toContain('conversionPrediction')
    expect(serialized).not.toContain('roiPrediction')
    expect(decision.limitations.join(' ')).toContain('truth score')
    expect(decision.limitations.join(' ')).toContain('搜尋排名預測')
    expect(decision.limitations.join(' ')).toContain('ROI 預測')
  })

  it('does not return raw malformed payload, stack, or secret fields', () => {
    const decision = evaluateAuthoritySource({ secretValue: 'synthetic-secret', nested: { raw: 'do-not-return' }, candidate: { sourceId: 'safe-id', sourceHash: 'secret-token' } })
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('synthetic-secret')
    expect(serialized).not.toContain('do-not-return')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('stack')
  })

  it('exposes all required public functions from index.ts', () => {
    expect(typeof canonicalAuthoritySourcePayload).toBe('function')
    expect(typeof authoritySourceHash).toBe('function')
    expect(typeof normalizeAuthoritySourceCandidate).toBe('function')
    expect(typeof evaluateAuthoritySource).toBe('function')
    expect(typeof selectAuthoritySources).toBe('function')
    expect(AUTHORITY_POLICY_LIMITATIONS.length).toBeGreaterThan(0)
  })

  it('keeps the engine offline and pure from the caller perspective', () => {
    const before = JSON.stringify(syntheticAuthoritySources.government)
    const decision = decisionFor(syntheticAuthoritySources.government)
    const after = JSON.stringify(syntheticAuthoritySources.government)
    expect(after).toBe(before)
    expect(decision.policyVersion).toBe(AUTHORITY_POLICY_VERSION)
  })

  it('requires recency review when citation metadata has no source dates', () => {
    const candidate = makeAuthoritySource({ publishedAt: null, updatedAt: null })
    const decision = decisionFor(candidate)
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('RECENCY_REVIEW_REQUIRED')
  })

  it('requires review for an unreviewed robots status during automated ingestion', () => {
    const decision = decisionFor(makeAuthoritySource({ robotsStatus: 'unreviewed' }), { workflowMode: 'automated_ingestion' })
    expect(decision.status).toBe('review_required')
    expect(decision.reasonCodes).toContain('ROBOTS_REVIEW_REQUIRED')
  })

  it('blocks an arXiv host whose source type is not preprint_repository', () => {
    const candidate = makeAuthoritySource({ sourceType: 'news', sourceUrl: 'https://arxiv.org/news/1', publisherDomain: 'arxiv.org' })
    const decision = decisionFor(candidate, { clientSector: 'healthcare', contentTopics: ['data governance'] })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('ARXIV_SOURCE_TYPE_REQUIRED')
  })

  it('does not produce a peer-review claim for any preprint source', () => {
    const decision = decisionFor(syntheticAuthoritySources.preprint, { purpose: 'research_reference', clientSector: 'technology', contentTopics: ['machine learning'], targetJurisdiction: null })
    expect(decision.limitations.some((item) => item.includes('peer reviewed source'))).toBe(false)
    expect(decision.limitations).toContain('preprint_not_peer_reviewed')
  })

  it('returns truthful rejection when every candidate is blocked', () => {
    const blocked = makeAuthoritySource({ copyrightRisk: 'blocked' })
    const result = selectAuthoritySources(makeSelectionRequest({ candidates: [blocked], maxSelected: 1 }))
    expect(result.status).toBe('rejected')
    expect(result.selected).toHaveLength(0)
    expect(result.blocked).toHaveLength(1)
  })

  it('normalizes sourceId and domain without changing caller data', () => {
    const original = makeAuthoritySource({ sourceId: '  Source ID  ', publisherDomain: 'STANDARDS.SYNTHETIC.EXAMPLE.ORG', sourceUrl: 'https://standards.synthetic.example.org/item' })
    const normalized = normalizeAuthoritySourceCandidate(original)
    expect(normalized?.sourceId).toBe('Source ID')
    expect(normalized?.publisherDomain).toBe('standards.synthetic.example.org')
    expect(original.sourceId).toBe('  Source ID  ')
  })

  it('rejects a blank source type, sector, or topic as malformed', () => {
    const source = makeAuthoritySource({ sourceType: '' as never, sectors: ['   '], topics: ['   '] })
    const decision = decisionFor(source)
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_INPUT')
  })

  it('rejects an invalid selection request without throwing', () => {
    expect(() => selectAuthoritySources(null)).not.toThrow()
    expect(selectAuthoritySources(null).status).toBe('rejected')
    expect(selectAuthoritySources({ candidates: 'not-an-array', maxSelected: 2 }).status).toBe('rejected')
  })

  it('keeps selection fingerprints stable across repeated evaluation', () => {
    const request = makeSelectionRequest({ candidates: sourceSetForTiers(), maxSelected: 3 })
    expect(selectAuthoritySources(request).selectionFingerprint).toBe(selectAuthoritySources(request).selectionFingerprint)
  })

  it('uses the asOf boundary when capturedAt is later', () => {
    const decision = decisionFor(makeAuthoritySource({ capturedAt: '2025-01-11T00:00:00.000Z' }))
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCodes).toContain('INVALID_INPUT')
  })

  it('keeps the configured asOf value deterministic', () => {
    const request = makeAuthorityRequest({ asOf: AUTHORITY_AS_OF })
    const first = evaluateAuthoritySource(request)
    const second = evaluateAuthoritySource(request)
    expect(first.decisionFingerprint).toBe(second.decisionFingerprint)
  })
})
