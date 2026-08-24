import type { AuthorityPurpose, AuthoritySourceType, AuthorityTier } from './types'

export const AUTHORITY_POLICY_VERSION = 'authority-source-policy-v1' as const

export const AUTHORITY_TIER_BY_SOURCE_TYPE: Record<AuthoritySourceType, AuthorityTier> = {
  government: 'primary',
  standards_body: 'primary',
  peer_reviewed_paper: 'primary',
  academic_institution: 'high',
  professional_association: 'high',
  first_party_expert: 'high',
  preprint_repository: 'contextual',
  industry_publication: 'contextual',
  news: 'contextual',
  commercial_blog: 'weak',
  community: 'weak',
  social: 'weak',
}

export const AUTHORITY_TIER_ORDER: readonly AuthorityTier[] = [
  'primary',
  'high',
  'contextual',
  'weak',
  'ineligible',
]

export const HIGH_RISK_AUTHORITY_SECTORS = [
  'healthcare',
  'medical',
  'medicine',
  'pharmaceutical',
  'legal',
  'law',
  'finance',
  'financial services',
  'investment',
  'insurance',
] as const

export const AUTHORITY_PURPOSE_ORDER: readonly AuthorityPurpose[] = [
  'research_reference',
  'content_citation',
  'evidence_support',
  'model_evaluation',
  'model_training',
]

export const AUTHORITY_POLICY_LIMITATIONS = [
  'approved 只表示來源 metadata 通過本 V1 的用途、相關性與治理規則，不代表內容為真。',
  '本 engine 不產生 truth score、搜尋排名預測、LLM 引用預測、流量、轉換或 ROI 預測。',
  '本 engine 不提供法律、醫療或投資建議；高風險產業來源仍須由合資格專業人員審查。',
  'preprint（包含 arXiv）不是 peer-reviewed 證據；本 engine 不得把 preprint 描述為已完成同儕審查。',
  '來源選擇只依傳入且已治理的 metadata；本 V1 不擷取全文、不驗證主張真偽，也不自動發布內容。',
  '授權、使用條款、robots、著作權與 PII 欄位不足時採 fail-closed，輸出可能是 review_required 或 blocked。',
] as const

export const AUTHORITY_REVIEW_LIMITATIONS = {
  insufficientApproved: 'approved 來源數量不足；review_required 或 blocked 來源不得被補入 selected。',
  duplicate: '偵測到 duplicate sourceId 或 sourceHash；重複項目已 fail closed，未靜默覆蓋。',
  recency: '來源沒有足夠的 publishedAt 或 updatedAt metadata，不能支持時效性主張。',
  jurisdiction: '來源 jurisdiction 與目標 jurisdiction 不一致或不足；法規／政策用途需要人工複核。',
  locale: '來源 locale 與目標 locale 不一致或不足；需要人工確認語境與適用範圍。',
} as const
