import type { ContentCalendarOpportunity, ContentCalendarRequest } from '../../../server/content-calendar'

export const SYNTHETIC_EVIDENCE_HASH = '1111111111111111111111111111111111111111111111111111111111111111'

export function syntheticOpportunity(overrides: Partial<ContentCalendarOpportunity> = {}): ContentCalendarOpportunity {
  return {
    id: 'opp-a',
    strategyRecommendationId: 1,
    title: 'Synthetic content opportunity A',
    contentType: 'article',
    language: 'en',
    priority: 'high',
    status: 'selected',
    topicCluster: 'cluster-a',
    evidenceSnapshotHash: SYNTHETIC_EVIDENCE_HASH,
    estimatedCostUnits: 10,
    ruleIds: ['rule-a', 'rule-b'],
    authoritySourceIds: ['authority-a'],
    ...overrides,
  }
}

export function syntheticRequest(overrides: Partial<ContentCalendarRequest> = {}): ContentCalendarRequest {
  return {
    clientScopeKey: 'scope_01',
    planStartDate: '2026-01-01',
    planEndDate: '2026-02-28',
    timeZone: 'Asia/Taipei',
    publishLocalTime: '09:30',
    cadenceDays: 7,
    monthlyBudgetUnits: 100,
    defaultCostUnits: 10,
    maxItemsPerCalendarMonth: 31,
    maximumTotalItems: 100,
    catchUpPolicy: 'skip_missed',
    evidenceSnapshotHash: SYNTHETIC_EVIDENCE_HASH,
    opportunities: [
      syntheticOpportunity({ id: 'opp-a', strategyRecommendationId: 1, topicCluster: 'cluster-a' }),
      syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, priority: 'medium', topicCluster: 'cluster-b', contentType: 'faq', language: 'zh-hant' }),
      syntheticOpportunity({ id: 'opp-c', strategyRecommendationId: 3, priority: 'low', topicCluster: 'cluster-a', contentType: 'service_page' }),
    ],
    ...overrides,
  }
}

export function manySyntheticOpportunities(count: number): ContentCalendarOpportunity[] {
  return Array.from({ length: count }, (_, index) => syntheticOpportunity({ id: `opp-${String(index).padStart(3, '0')}`, strategyRecommendationId: index + 1, priority: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'medium' : 'low', topicCluster: `cluster-${index % 5}`, estimatedCostUnits: (index % 5) + 1 }))
}
