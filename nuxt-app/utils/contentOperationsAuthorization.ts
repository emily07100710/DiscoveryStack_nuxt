export type ContentAuthorizationMode = '' | 'legacy_v3' | 'weekly_customer_approval'
export type ContentAuthorizationClient = { id: string | number; framework: string; requireCustomerApproval?: boolean }
export type ContentAuthorizationTarget = { id: string | number; clientId: string | number; targetId: string; status: string; executionEnabled: boolean; allowedContentTypes?: readonly string[]; allowedLanguages?: readonly string[]; websiteId?: string | null }
export type ContentAuthorizationInput = { mode: ContentAuthorizationMode; expiresOn: string; maximumRiskLevel: 'low' | 'general' | 'high'; generationBudget: unknown; publicationBudget: unknown; targetRowId: unknown; entityStrategyProfileId?: unknown; confirmed: boolean }
export type ContentAuthorizationBody = {
  policyVersion: 'governed-autopilot-policy-v3' | 'governed-autopilot-policy-v4'; expiresAt: string; maximumRiskLevel: 'low' | 'general' | 'high'; allowedContentTypes: string[]; allowedLanguages: string[];
  targetRowId?: number; websiteId?: string; entityStrategyProfileId?: string; cadenceDays?: 7; allowedCadences?: number[]; allowedTargetIds?: string[]; allowedDestinations?: string[]; generationBudget?: number; publicationBudget?: number; requireApprovedForDelivery?: false; maximumRiskSeverity?: 'low' | 'moderate'; allowedBusinessRiskClasses?: ['general'];
}
export type ContentAuthorizationProfile = { profileId: string; clientId: string | number; websiteId: string; status: string; canonicalBrandName?: string; revokedAt?: unknown }
export type ContentAuthorizationPolicy = { targetRowId?: string | number; targetId: string; status?: string }
export type ContentAuthorizationContext = { profiles: readonly ContentAuthorizationProfile[]; policies: readonly ContentAuthorizationPolicy[]; policiesLoaded: boolean }
export function newWeeklyAuthorizationTargets<T extends ContentAuthorizationTarget>(client: ContentAuthorizationClient, targets: readonly T[], policies: readonly ContentAuthorizationPolicy[], policiesLoaded: boolean): T[] {
  if (policiesLoaded !== true) return []
  return targets.filter(target => String(target.clientId) === String(client.id) && target.status === 'active' && target.executionEnabled === true && target.allowedContentTypes?.includes('article') && target.allowedLanguages?.includes('zh-hant') && Boolean(target.websiteId?.trim()) && !policies.some(policy => String(policy.targetRowId) === String(target.id) || policy.targetId === target.targetId))
}
const MAXIMUM_AUTHORIZATION_BUDGET = 1000000
function budget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_AUTHORIZATION_BUDGET) throw new Error('請填入 1 到 1,000,000 之間的整數額度。')
  return value
}
function expiry(expiresOn: string, now: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new Error('請選擇有效的授權到期日。')
  const instant = new Date(`${expiresOn}T23:59:59.000Z`)
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== expiresOn || instant.getTime() <= now.getTime()) throw new Error('授權到期日已過期或不正確，請重新選擇。')
  return instant.toISOString()
}
/** Creates an owner policy request only after the confirmation dialog succeeds. No IO or authorization writes. */
export function buildContentOperationsAuthorization(input: ContentAuthorizationInput, client: ContentAuthorizationClient, targets: readonly ContentAuthorizationTarget[], now = new Date(), context: ContentAuthorizationContext = { profiles: [], policies: [], policiesLoaded: false }): ContentAuthorizationBody {
  if (input.confirmed !== true) throw new Error('請先完成這次授權的確認。')
  if (!['legacy_v3', 'weekly_customer_approval'].includes(input.mode)) throw new Error('請明確選擇文章授權模式。')
  if (!['low', 'general', 'high'].includes(input.maximumRiskLevel)) throw new Error('請選擇有效的內容風險限制。')
  const expiresAt = expiry(input.expiresOn, now)
  if (input.mode === 'legacy_v3') return { policyVersion: 'governed-autopilot-policy-v3', expiresAt, maximumRiskLevel: input.maximumRiskLevel, allowedContentTypes: client.framework === 'nextjs' ? ['article'] : ['article', 'faq', 'service_page'], allowedLanguages: client.framework === 'nextjs' ? ['zh-hant'] : ['en', 'zh-hant'] }
  if (client.requireCustomerApproval !== true) throw new Error('請先到每週文章後台，將這位客戶改為同意後才發文。')
  if (input.maximumRiskLevel === 'high') throw new Error('每週客戶送審模式只開放一般或低風險內容。')
  if (typeof input.targetRowId !== 'number' || !Number.isSafeInteger(input.targetRowId) || input.targetRowId < 1) throw new Error('請明確選擇這位客戶的發布目標。')
  if (context.policiesLoaded !== true) throw new Error('發布目標的既有授權尚未確認，請重新整理後再試。')
  const target = newWeeklyAuthorizationTargets(client, targets, context.policies, context.policiesLoaded).find(row => Number(row.id) === input.targetRowId)
  if (!target || target.status !== 'active' || target.executionEnabled !== true || !target.allowedContentTypes?.includes('article') || !target.allowedLanguages?.includes('zh-hant') || !target.targetId.trim()) throw new Error('請選擇已啟用、可發布繁體中文文章的客戶發布目標。')
  if (typeof input.entityStrategyProfileId !== 'string' || !input.entityStrategyProfileId.trim()) throw new Error('請明確選擇已保存的客戶實體策略。')
  const profile = context.profiles.find(row => row.profileId === input.entityStrategyProfileId && String(row.clientId) === String(client.id) && row.websiteId === target.websiteId && row.status === 'active' && row.revokedAt == null)
  if (!profile) throw new Error('客戶實體策略已失效或不屬於這個網站，請重新選擇。')
  return { policyVersion: 'governed-autopilot-policy-v4', websiteId: target.websiteId!, entityStrategyProfileId: profile.profileId, expiresAt, maximumRiskLevel: input.maximumRiskLevel, maximumRiskSeverity: input.maximumRiskLevel === 'low' ? 'low' : 'moderate', allowedBusinessRiskClasses: ['general'], allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], targetRowId: input.targetRowId, allowedTargetIds: [target.targetId], allowedDestinations: [target.targetId], cadenceDays: 7, allowedCadences: [7], generationBudget: budget(input.generationBudget), publicationBudget: budget(input.publicationBudget), requireApprovedForDelivery: false }
}

export function contentTargetFrameworkDefaults(framework: string, current: { contentRoot: string; maximumPayloadBytes: number; endpointPath: string }) {
  return framework === 'nextjs' ? { contentRoot: 'journal', maximumPayloadBytes: 196608, endpointPath: '/api/first-party/content-ingest' } : { ...current }
}
