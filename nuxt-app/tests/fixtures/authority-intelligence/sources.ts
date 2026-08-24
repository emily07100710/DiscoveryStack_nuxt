import {
  authoritySourceHash,
  type AuthorityPolicyRequest,
  type AuthoritySourceCandidate,
  type AuthoritySourceSelectionRequest,
} from '../../../server/authority-intelligence'

export const AUTHORITY_AS_OF = '2025-01-10T00:00:00.000Z'
export const AUTHORITY_CAPTURED_AT = '2025-01-09T00:00:00.000Z'

const DEFAULT_SOURCE: AuthoritySourceCandidate = {
  sourceId: 'synthetic-government-001',
  sourceName: 'Synthetic Public Standards Office',
  sourceUrl: 'https://standards.synthetic.example.org/guidance/001#source',
  publisherDomain: 'standards.synthetic.example.org',
  title: 'Synthetic healthcare data governance guidance',
  sourceType: 'government',
  sectors: ['healthcare', 'public policy'],
  topics: ['data governance', 'synthetic testing'],
  locale: 'en',
  jurisdiction: 'us',
  publisher: 'Synthetic Public Standards Office',
  publishedAt: '2024-12-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  capturedAt: AUTHORITY_CAPTURED_AT,
  licenceStatus: 'verified_permissive',
  termsStatus: 'allows_citation',
  robotsStatus: 'not_applicable',
  copyrightRisk: 'low',
  piiStatus: 'none_detected',
  accessMethod: 'manual',
  evidenceLocator: 'section-1',
  sourceHash: '',
}

export function makeAuthoritySource(overrides: Partial<AuthoritySourceCandidate> = {}): AuthoritySourceCandidate {
  const candidate: AuthoritySourceCandidate = {
    ...DEFAULT_SOURCE,
    ...overrides,
    sectors: overrides.sectors ?? [...DEFAULT_SOURCE.sectors],
    topics: overrides.topics ?? [...DEFAULT_SOURCE.topics],
  }
  const suppliedHash = overrides.sourceHash
  const { sourceHash: _ignored, ...withoutHash } = candidate
  return { ...candidate, sourceHash: suppliedHash ?? authoritySourceHash(withoutHash) }
}

export function makeAuthorityRequest(overrides: Partial<AuthorityPolicyRequest> = {}): AuthorityPolicyRequest {
  return {
    purpose: 'content_citation',
    clientSector: 'healthcare',
    contentTopics: ['data governance'],
    targetLocale: 'en',
    targetJurisdiction: 'us',
    workflowMode: 'manual_review',
    asOf: AUTHORITY_AS_OF,
    candidate: makeAuthoritySource(overrides.candidate ? { ...overrides.candidate } : {}),
    ...overrides,
  }
}

export function makeSelectionRequest(overrides: Partial<AuthoritySourceSelectionRequest> = {}): AuthoritySourceSelectionRequest {
  const base = makeAuthorityRequest()
  return {
    purpose: base.purpose,
    clientSector: base.clientSector,
    contentTopics: base.contentTopics,
    targetLocale: base.targetLocale,
    targetJurisdiction: base.targetJurisdiction,
    workflowMode: base.workflowMode,
    asOf: base.asOf,
    candidates: [makeAuthoritySource()],
    maxSelected: 3,
    ...overrides,
  }
}

export const syntheticAuthoritySources = {
  government: makeAuthoritySource(),
  standards: makeAuthoritySource({ sourceId: 'synthetic-standards-001', sourceName: 'Synthetic Standards Body', sourceUrl: 'https://standards.synthetic.example.org/standards/001', sourceType: 'standards_body', title: 'Synthetic standards for data governance' }),
  peerReviewed: makeAuthoritySource({ sourceId: 'synthetic-paper-001', sourceName: 'Synthetic Peer Review Journal', sourceUrl: 'https://journal.synthetic.example.org/papers/001', publisherDomain: 'journal.synthetic.example.org', sourceType: 'peer_reviewed_paper', title: 'Synthetic peer reviewed data governance paper' }),
  preprint: makeAuthoritySource({ sourceId: 'synthetic-preprint-001', sourceName: 'Synthetic Preprint Repository', sourceUrl: 'https://arxiv.org/abs/1234.5678', publisherDomain: 'arxiv.org', sourceType: 'preprint_repository', title: 'Synthetic machine learning preprint', sectors: ['technology'], topics: ['machine learning'], termsStatus: 'allows_research' }),
  commercialBlog: makeAuthoritySource({ sourceId: 'synthetic-blog-001', sourceName: 'Synthetic Commercial Blog', sourceUrl: 'https://blog.synthetic.example.org/posts/001', publisherDomain: 'blog.synthetic.example.org', sourceType: 'commercial_blog', title: 'Synthetic marketing perspective' }),
}
