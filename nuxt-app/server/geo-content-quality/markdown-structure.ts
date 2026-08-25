import type { MarkdownStructureReport, MarkdownStructureResult, MarkdownFaqPair } from './types'
import type { ReasonCode } from './reason-codes'

const SIMPLIFIED_CHARACTERS = /[让们务与为个这从对专业业转化联络应设实说国]/u

function emptyReport(): MarkdownStructureReport {
  return { titleHeading: null, headingLevels: [], h2Count: 0, h3Count: 0, headingLevelJump: false, emptySection: false, duplicateNormalizedHeadings: [], firstMeaningfulParagraph: null, directAnswerFirst: false, duplicateParagraphs: [], faqSectionFound: false, faqPairs: [], duplicateFaqQuestions: [], citationMarkerCount: 0, citationMarkerPlacementValid: false, conclusionOrCtaFound: false, templateFillerFound: false, simplifiedChineseFound: false, meaningfulParagraphCount: 0 }
}

function normalizeHeading(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function normalizeParagraph(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function isFence(line: string): boolean { return /^\s*(```|~~~)/u.test(line) }
function isHeading(line: string): { level: number, title: string } | null {
  const match = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/u.exec(line)
  return match ? { level: match[1]!.length, title: match[2]!.trim() } : null
}
function isMeaningfulLine(line: string): boolean {
  const trimmed = line.trim()
  return Boolean(trimmed) && !/^([-*_])(?:\s*\1){2,}$/u.test(trimmed) && !/^<!--.*-->$/u.test(trimmed)
}
function titleIncludes(value: string, patterns: RegExp[]): boolean { return patterns.some(pattern => pattern.test(value)) }

function parseFaqPairs(lines: string[], faqHeadingIndexes: Set<number>): MarkdownFaqPair[] {
  const pairs: MarkdownFaqPair[] = []
  for (const index of [...faqHeadingIndexes].sort((left, right) => left - right)) {
    let question: string | null = null
    let answerLines: string[] = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const heading = isHeading(lines[cursor]!)
      if (heading && heading.level <= 2) break
      const line = lines[cursor]!.trim()
      if (!line) continue
      const questionMatch = /^(?:Q(?:uestion)?\s*[:：]|問(?:題)?\s*[:：])?(.{3,}[?？])$/iu.exec(line)
      if (questionMatch && (line.endsWith('?') || line.endsWith('？') || /^Q(?:uestion)?\s*[:：]|^問/iu.test(line))) {
        if (question !== null && answerLines.length) pairs.push({ question, answer: answerLines.join(' ').trim() })
        question = questionMatch[1]!.trim()
        answerLines = []
      } else if (question !== null) {
        answerLines.push(line)
      }
    }
    if (question !== null && answerLines.length) pairs.push({ question, answer: answerLines.join(' ').trim() })
  }
  return pairs
}

export function parseMarkdownStructure(value: unknown): MarkdownStructureResult {
  if (typeof value !== 'string') return { status: 'invalid', report: emptyReport(), reasonCodes: ['INVALID_INPUT'] }
  if (!value.trim()) return { status: 'invalid', report: emptyReport(), reasonCodes: ['EMPTY_REQUIRED_FIELD'] }
  const lines = value.replace(/\r\n?/gu, '\n').split('\n')
  const headings: Array<{ level: number, title: string, line: number }> = []
  const paragraphs: string[] = []
  const paragraphLineIndexes: number[] = []
  const faqHeadingIndexes = new Set<number>()
  const fenceLines = new Set<number>()
  let inFence = false
  let currentParagraph: string[] = []
  let currentStart = -1
  const flushParagraph = () => {
    const text = currentParagraph.join(' ').replace(/\s+/gu, ' ').trim()
    if (text && !/^#{1,6}\s/u.test(text)) { paragraphs.push(text); paragraphLineIndexes.push(currentStart) }
    currentParagraph = []
    currentStart = -1
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (isFence(line)) { fenceLines.add(index); inFence = !inFence; flushParagraph(); continue }
    if (inFence) { fenceLines.add(index); continue }
    const heading = isHeading(line)
    if (heading) {
      flushParagraph()
      headings.push({ ...heading, line: index })
      if (titleIncludes(normalizeHeading(heading.title), [/faq/u, /常見問題/u, /常見問答/u])) faqHeadingIndexes.add(index)
      continue
    }
    if (!isMeaningfulLine(line)) { flushParagraph(); continue }
    if (currentStart < 0) currentStart = index
    currentParagraph.push(line.trim())
  }
  flushParagraph()

  const duplicateHeadingMap = new Map<string, number>()
  for (const heading of headings) {
    const key = normalizeHeading(heading.title)
    if (key) duplicateHeadingMap.set(key, (duplicateHeadingMap.get(key) || 0) + 1)
  }
  const duplicateNormalizedHeadings = [...duplicateHeadingMap.entries()].filter(([, count]) => count > 1).map(([key]) => key)
  const headingLevelJump = headings.some((heading, index) => index === 0 ? heading.level > 1 : heading.level > headings[index - 1]!.level + 1)
  const emptySection = headings.some((heading, index) => {
    const nextHeadingLine = headings[index + 1]?.line ?? lines.length
    return !paragraphs.some((_, paragraphIndex) => paragraphLineIndexes[paragraphIndex]! > heading.line && paragraphLineIndexes[paragraphIndex]! < nextHeadingLine)
  })
  const paragraphMap = new Map<string, number>()
  for (const paragraph of paragraphs) { const key = normalizeParagraph(paragraph); if (key) paragraphMap.set(key, (paragraphMap.get(key) || 0) + 1) }
  const duplicateParagraphs = [...paragraphMap.entries()].filter(([, count]) => count > 1).map(([key]) => key)
  const firstMeaningfulParagraph = paragraphs[0] || null
  const directAnswerFirst = Boolean(firstMeaningfulParagraph && firstMeaningfulParagraph.length >= 20 && !/^(?:本文|this article|in this article|以下將|以下将)/iu.test(firstMeaningfulParagraph))
  const faqPairs = parseFaqPairs(lines, faqHeadingIndexes)
  const faqQuestionMap = new Map<string, number>()
  for (const pair of faqPairs) { const key = normalizeParagraph(pair.question); faqQuestionMap.set(key, (faqQuestionMap.get(key) || 0) + 1) }
  const duplicateFaqQuestions = [...faqQuestionMap.entries()].filter(([, count]) => count > 1).map(([key]) => key)
  const prose = paragraphs.join('\n')
  const citationMarkerCount = (prose.match(/\[[A-Za-z0-9_-]{1,80}\]|\(https?:\/\/[^\s)]+\)/gu) || []).length
  const citationMarkerPlacementValid = citationMarkerCount === 0 ? true : paragraphs.every(paragraph => !/\[[A-Za-z0-9_-]{1,80}\]|\(https?:\/\/[^\s)]+\)/gu.test(paragraph) || paragraph.length > 10)
  const normalizedHeadingValues = headings.map(heading => normalizeHeading(heading.title))
  const conclusionOrCtaFound = titleIncludes(normalizedHeadingValues.join('|'), [/conclusion/u, /結論/u, /next step/u, /下一步/u, /cta/u, /聯絡/u, /联系/u, /contact/u])
  const templateFillerFound = /lorem ipsum|\[\s*(?:insert|add|fill|待補|待补|填入)|\b(?:todo|tbd)\b|your\s+(?:text|content|company)\s+here/iu.test(value)
  const simplifiedChineseFound = SIMPLIFIED_CHARACTERS.test(value)
  const report: MarkdownStructureReport = { titleHeading: headings.find(heading => heading.level === 1)?.title || null, headingLevels: headings.map(heading => heading.level), h2Count: headings.filter(heading => heading.level === 2).length, h3Count: headings.filter(heading => heading.level === 3).length, headingLevelJump, emptySection, duplicateNormalizedHeadings, firstMeaningfulParagraph, directAnswerFirst, duplicateParagraphs, faqSectionFound: faqHeadingIndexes.size > 0, faqPairs, duplicateFaqQuestions, citationMarkerCount, citationMarkerPlacementValid, conclusionOrCtaFound, templateFillerFound, simplifiedChineseFound, meaningfulParagraphCount: paragraphs.length }
  const reasonCodes: ReasonCode[] = []
  if (headingLevelJump) reasonCodes.push('INVALID_HEADING_HIERARCHY')
  if (emptySection) reasonCodes.push('EMPTY_SECTION')
  if (duplicateNormalizedHeadings.length) reasonCodes.push('DUPLICATE_HEADING')
  if (duplicateParagraphs.length) reasonCodes.push('DUPLICATE_PARAGRAPH')
  if (!directAnswerFirst) reasonCodes.push('DIRECT_ANSWER_MISSING')
  if (duplicateFaqQuestions.length) reasonCodes.push('DUPLICATE_FAQ')
  if (report.faqSectionFound && faqPairs.length === 0) reasonCodes.push('FAQ_INTEGRITY_FAILURE')
  if (!citationMarkerPlacementValid) reasonCodes.push('INVALID_CITATION_BINDING')
  if (templateFillerFound) reasonCodes.push('TEMPLATE_FILLER')
  if (simplifiedChineseFound) reasonCodes.push('UNSUPPORTED_LOCALE_OUTPUT')
  return reasonCodes.length ? { status: 'invalid', report, reasonCodes } : { status: 'valid', report, reasonCodes: [] }
}
