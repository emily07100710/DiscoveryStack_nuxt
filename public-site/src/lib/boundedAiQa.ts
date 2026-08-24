export type QaLocale = 'en' | 'zh-hant'
export type BoundedQaResult = { answer: string, isFallback: boolean, topic: 'seo_geo' | 'audit' | 'ai_scope' | 'web' | 'systems' | 'marketing' | 'handoff' }

export const humanHandoff: Record<QaLocale, string> = {
  en: 'I do not yet have a reliable public answer for that. A DiscoveryStack strategist can help you clarify the commercial, legal, technical or account-specific context with care.',
  'zh-hant': '這個問題目前沒有適合直接公開回答的依據。DiscoveryStack 策略師可以陪你一起釐清其中的商業、法律、技術或帳戶特定脈絡。',
}

export function answerBoundedQa(question: string, locale: QaLocale): BoundedQaResult {
  const normalized = question.toLocaleLowerCase(locale === 'zh-hant' ? 'zh-Hant' : 'en')
  if (normalized.includes('網站') || normalized.includes('官網') || normalized.includes('web') || normalized.includes('website')) return { topic: 'web', isFallback: false, answer: locale === 'zh-hant'
    ? '網站做完卻沒人找到，通常不能只改視覺。我們會一起檢查品牌承諾、技術結構、SEO／GEO、內容入口與轉換行動，再由網站設計部和 SEO／GEO 部排出先後順序。'
    : 'When a finished website still cannot be found, visual changes alone are rarely enough. We review the promise, technical structure, SEO/GEO, content routes and conversion action, then let Web Design and SEO/GEO order the work.' }
  if (normalized.includes('系統') || normalized.includes('資料庫') || normalized.includes('database') || normalized.includes('system') || normalized.includes('串接')) return { topic: 'systems', isFallback: false, answer: locale === 'zh-hant'
    ? '可以從網站、資料庫、CRM、後台與自動化流程一起規劃。系統規劃部先釐清資料如何流動，再決定哪些部分需要 API、客製系統或 AI，避免先買工具再勉強拼接。'
    : 'We can plan the website, database, CRM, operations and automation together. Systems first maps how data should move, then decides where APIs, custom software or AI are justified.' }
  if (normalized.includes('流量') || normalized.includes('訂單') || normalized.includes('轉換') || normalized.includes('行銷') || normalized.includes('traffic') || normalized.includes('order') || normalized.includes('marketing')) return { topic: 'marketing', isFallback: false, answer: locale === 'zh-hant'
    ? '有流量卻沒有訂單，代表注意力沒有被順利推進。行銷部會和網站設計、SEO／GEO 一起看受眾、入口頁、承諾、證據與 CTA；若需要追蹤或自動化，再由系統與 AI 部門加入。'
    : 'Traffic without orders means attention is not moving forward. Marketing reviews audience, landing route, promise, evidence and CTA with Web Design and SEO/GEO, bringing in Systems and AI where tracking or automation is needed.' }
  if (normalized.includes('audit') || normalized.includes('稽核')) return { topic: 'audit', isFallback: false, answer: locale === 'zh-hant'
    ? '我們會先一起看公開網站中能辨識的結構訊號，例如主 CTA、服務分流、真人聯絡與下一步。需要策略判斷或訓練候選資料時，仍會由人類仔細覆核。'
    : 'We can start with public structural signals—such as the primary CTA, service routing, human contact and the next step. Strategy judgments and training candidates are then considered carefully with human review.' }
  if (normalized.includes('ai') || normalized.includes('亂') || normalized.includes('make things up')) return { topic: 'ai_scope', isFallback: false, answer: locale === 'zh-hant'
    ? '我們不只是接上通用 AI，也有實際訓練、版本化與人工覆核的機器學習流程。這個助手只在已核准的服務與知識範圍內提供方向；需要商業判斷時會交給真人。'
    : 'We do more than attach generic AI: our machine-learning workflow is trained, versioned and human-reviewed. This assistant stays within approved service and knowledge boundaries, handing commercial judgment to a person.' }
  if (normalized.includes('seo') || normalized.includes('geo') || normalized.includes('搜尋')) return { topic: 'seo_geo', isFallback: false, answer: locale === 'zh-hant'
    ? '可以。我們會把 SEO／GEO 內容、可見證據、客戶路徑與真人交接放在同一套系統裡，先一起找出需求在哪裡失去方向。這不是排名保證；它讓合適的人更容易找到、理解並走向下一步。'
    : 'Yes. We bring SEO/GEO content, visible evidence, customer paths and human handoff into one system, starting by clarifying where demand loses its way. It is not a ranking guarantee; it makes qualified discovery, understanding and the next step more possible.' }
  return { topic: 'handoff', isFallback: true, answer: humanHandoff[locale] }
}
