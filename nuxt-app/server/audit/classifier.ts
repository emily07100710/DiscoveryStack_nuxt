import type { ClassifiableObservation, FrictionAssessmentDraft, JourneyStage } from './types'

type Rule = { observationKey: string, expects: string, weight: number }
const frictionRules: Record<Exclude<JourneyStage, 'conversion'>, Rule[]> = {
  discovery: [{ observationKey: 'seo.title_present', expects: 'false', weight: 1 }, { observationKey: 'content.h1_present', expects: 'false', weight: 1 }, { observationKey: 'content.service_language', expects: 'false', weight: 1.5 }, { observationKey: 'content.faq_present', expects: 'false', weight: 0.75 }],
  understanding: [{ observationKey: 'content.service_language', expects: 'false', weight: 2 }, { observationKey: 'content.h1_present', expects: 'false', weight: 1.25 }, { observationKey: 'seo.title_present', expects: 'false', weight: 0.75 }],
  response: [{ observationKey: 'journey.contact_route', expects: 'false', weight: 1.5 }, { observationKey: 'journey.booking_route', expects: 'false', weight: 1 }, { observationKey: 'journey.cta_present', expects: 'false', weight: 1.25 }],
  progression: [{ observationKey: 'journey.cta_present', expects: 'false', weight: 2 }, { observationKey: 'journey.booking_route', expects: 'false', weight: 1.5 }, { observationKey: 'journey.contact_route', expects: 'false', weight: 0.75 }],
}

const copy = (language: 'en' | 'zh-hant', stage: JourneyStage, status: FrictionAssessmentDraft['assessmentStatus']) => {
  const messages = {
    en: { discovery: 'Public-page signals suggest discoverability and machine-readable clarity need review.', understanding: 'Public-page signals suggest the service value or next step may not be expressed clearly enough.', response: 'Public-page signals suggest enquiry and human-response routes may not be clear enough.', progression: 'Public-page signals suggest friction between understanding the service and taking the next step.', conversion: 'No authorised commerce, CRM, analytics, or closed-won events are connected, so real conversion cannot be assessed.', insufficient: 'There is not enough independent public-page evidence; strategist review or authorised data is required.' },
    'zh-hant': { discovery: '公開頁面訊號顯示，被發現與機器可讀清晰度需要進一步檢查。', understanding: '公開頁面訊號顯示，服務價值或下一步的表述可能不夠清楚。', response: '公開頁面訊號顯示，詢問與真人回覆的入口可能不夠清楚。', progression: '公開頁面訊號顯示，從理解服務到採取下一步的路徑可能有摩擦。', conversion: '沒有已授權的電商、CRM、分析或成交事件，因此無法判斷真實轉化。', insufficient: '獨立公開頁面證據不足，需策略師覆核或接入已授權資料。' },
  } as const
  if (stage === 'conversion') return messages[language].conversion
  return status === 'insufficient_evidence' ? messages[language].insufficient : messages[language][stage]
}

/** Deliberately explainable pre-training baseline: finds missing public signals but never claims private business outcomes. */
export function classifyJourneyFriction(observations: ClassifiableObservation[], language: 'en' | 'zh-hant'): FrictionAssessmentDraft[] {
  const drafts: FrictionAssessmentDraft[] = (Object.keys(frictionRules) as Array<Exclude<JourneyStage, 'conversion'>>).map(stage => {
    const evidence = frictionRules[stage].flatMap(rule => observations.filter(observation => observation.observationKey === rule.observationKey && observation.valueText === rule.expects).map(observation => ({ observationId: observation.id, observationKey: observation.observationKey, evidenceQuote: observation.evidenceQuote || undefined, sourceUrl: observation.sourceUrl, weight: rule.weight })))
    const status: FrictionAssessmentDraft['assessmentStatus'] = new Set(evidence.map(item => item.observationKey)).size >= 2 ? 'supported' : 'insufficient_evidence'
    return { journeyStage: stage, priorityRank: 0, score: evidence.reduce((sum, item) => sum + item.weight, 0), assessmentStatus: status, summary: copy(language, stage, status), evidence: evidence.map(({ observationId: _id, ...item }) => item), observationIds: evidence.map(item => item.observationId), requiresHumanReview: true as const }
  })
  drafts.push({ journeyStage: 'conversion', priorityRank: 0, score: 0, assessmentStatus: 'insufficient_evidence', summary: copy(language, 'conversion', 'insufficient_evidence'), evidence: [], observationIds: [], requiresHumanReview: true })
  return drafts.sort((left, right) => Number(right.assessmentStatus === 'supported') - Number(left.assessmentStatus === 'supported') || right.score - left.score || left.journeyStage.localeCompare(right.journeyStage)).map((draft, index) => ({ ...draft, priorityRank: index + 1 }))
}
