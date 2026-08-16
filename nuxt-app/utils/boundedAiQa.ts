export type QaLocale = 'en' | 'zh-hant'
export type BoundedQaResult = { answer: string, isFallback: boolean, topic: 'seo_geo' | 'audit' | 'ai_scope' | 'handoff' }

export const humanHandoff: Record<QaLocale, string> = {
  en: 'I do not yet have a reliable public answer for that. A DiscoveryStack strategist can help you clarify the commercial, legal, technical or account-specific context with care.',
  'zh-hant': '這個問題目前沒有適合直接公開回答的依據。DiscoveryStack 策略師可以陪你一起釐清其中的商業、法律、技術或帳戶特定脈絡。',
}

export function answerBoundedQa(question: string, locale: QaLocale): BoundedQaResult {
  const normalized = question.toLocaleLowerCase(locale === 'zh-hant' ? 'zh-Hant' : 'en')
  if (normalized.includes('audit') || normalized.includes('稽核')) return { topic: 'audit', isFallback: false, answer: locale === 'zh-hant'
    ? '我們會先一起看公開網站中能辨識的結構訊號，例如主 CTA、服務分流、真人聯絡與下一步。需要策略判斷或訓練候選資料時，仍會由人類仔細覆核。'
    : 'We can start with public structural signals—such as the primary CTA, service routing, human contact and the next step. Strategy judgments and training candidates are then considered carefully with human review.' }
  if (normalized.includes('ai') || normalized.includes('亂') || normalized.includes('make things up')) return { topic: 'ai_scope', isFallback: false, answer: locale === 'zh-hant'
    ? '這個助手會盡量只根據已核准的服務、方法與知識範圍提供方向；如果問題需要更多商業脈絡或策略判斷，我們會邀請真人和你一起確認。'
    : 'This assistant stays close to approved service, method and knowledge boundaries. When a question needs more business context or strategic judgment, we invite a person into the conversation with you.' }
  if (normalized.includes('seo') || normalized.includes('geo') || normalized.includes('搜尋')) return { topic: 'seo_geo', isFallback: false, answer: locale === 'zh-hant'
    ? '可以。我們會把 SEO／GEO 內容、可見證據、客戶路徑與真人交接放在同一套系統裡，先一起找出需求在哪裡失去方向。這不是排名保證；它讓合適的人更容易找到、理解並走向下一步。'
    : 'Yes. We bring SEO/GEO content, visible evidence, customer paths and human handoff into one system, starting by clarifying where demand loses its way. It is not a ranking guarantee; it makes qualified discovery, understanding and the next step more possible.' }
  return { topic: 'handoff', isFallback: true, answer: humanHandoff[locale] }
}
