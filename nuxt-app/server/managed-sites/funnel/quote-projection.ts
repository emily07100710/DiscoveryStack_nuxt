import { createError } from 'h3'
import { projectManagedSiteCatalogQuote } from '../ordering-service'
import { managedSiteQuoteLineBilling } from '../quote-line-billing'
import { buildSiteSpec, type SiteBriefInput, type SiteSpec } from '../site-spec'
import type { QuoteInput } from '../ordering-types'
import type { FunnelAnswers } from './session-service'

function incomplete(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

export function funnelPreviewInput(answers: FunnelAnswers, sessionId: number): SiteBriefInput {
  const company = answers.company || incomplete('Company details are required before building the website.')
  const style = answers.style || incomplete('Style choices are required before building the website.')
  const siteType = answers.siteType || incomplete('Site type is required before building the website.')
  const audience = company.feelings.length ? company.feelings.join('、') : '品牌網站訪客'
  const existingSiteContext = answers.existingSite?.hasSite && answers.existingSite.url ? `現有網站：${answers.existingSite.url}` : '本次建立新網站。'
  const previewContext = answers.previewDraft?.headline ? `草稿主標題：${answers.previewDraft.headline}` : ''
  return {
    draftIdentity: `managed-site-funnel-${sessionId}`,
    locale: 'zh-hant',
    brandName: company.brandName,
    audience,
    brief: [company.whatWeDo, `主要服務：${company.mainOffer}`, existingSiteContext, previewContext, style.stylePreset ? `風格偏好：${style.stylePreset}` : ''].filter(Boolean).join('\n'),
    businessGoals: company.conversionGoals as SiteBriefInput['businessGoals'],
    siteType,
    selectedModules: [...(answers.modules || [])] as SiteBriefInput['selectedModules'],
    styleReferences: style.referenceUrls.map(url => ({ url, selectedPreferences: ['color', 'typography_mood', 'whitespace_density', 'homepage_structure', 'image_ratio', 'animation_rhythm'] })),
  }
}

/** The single funnel-answer to managed-site-spec mapping used by quotes and preview drafts. */
export function funnelSiteSpec(answers: FunnelAnswers, sessionId: number): SiteSpec {
  return buildSiteSpec(funnelPreviewInput(answers, sessionId))
}

export function funnelCatalogQuoteInput(answers: FunnelAnswers, sessionId: number): Parameters<typeof projectManagedSiteCatalogQuote>[0] {
  const plan = answers.plan || incomplete('Plan selection is required before calculating the quote.')
  const domain = answers.domain || incomplete('Domain selection is required before calculating the quote.')
  const style = answers.style || incomplete('Style choices are required before calculating the quote.')
  const spec = funnelSiteSpec(answers, sessionId)
  return {
    siteType: spec.siteType,
    planKey: plan.planKey as QuoteInput['planKey'],
    cadenceDays: plan.cadenceDays,
    domainOption: domain.option,
    designTier: style.designTier,
    domainTld: domain.option === 'new' ? domain.tld as QuoteInput['domainTld'] : undefined,
    moduleKeys: spec.selectedModules,
  }
}

export function projectFunnelQuote(answers: FunnelAnswers, sessionId = 1) {
  const projection = projectManagedSiteCatalogQuote(funnelCatalogQuoteInput(answers, sessionId))
  return {
    lines: projection.lines.map(line => ({
      lineKey: line.lineKey,
      description: line.description,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
      lineAmountMinor: line.lineAmountMinor,
      billing: managedSiteQuoteLineBilling(line.lineKey),
    })),
    totals: projection.totals,
    currency: projection.currency,
    manualServiceModules: projection.manualServiceModules,
    manualSetupModules: projection.manualSetupModules,
    comingSoonModules: projection.comingSoonModules,
  }
}
