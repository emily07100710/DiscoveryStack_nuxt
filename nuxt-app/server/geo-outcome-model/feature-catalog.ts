import { GEO_OUTCOME_FEATURE_CATALOG_VERSION, MAX_FEATURES } from './constants'
import type { FeatureDefinition, FeatureValue, FeatureVector, OutcomeObservation } from './types'

const categorical = (key: string, description: string, values: readonly string[]): FeatureDefinition[] => values.filter(value => value !== 'unknown').map(value => ({ key: `${key}=${value}`, description: `${description}: ${value}`, kind: 'categorical', bounded: '0..1' }))

export const FEATURE_CATALOG: readonly FeatureDefinition[] = [
  ...categorical('contentType', 'Content type', ['article', 'faq', 'product', 'landing_page', 'documentation', 'other']),
  ...categorical('locale', 'Locale', ['en', 'zh-hant', 'zh-hans', 'ja', 'ko', 'de', 'fr']),
  ...categorical('pageAgeBucket', 'Page age', ['0_7d', '8_30d', '31_90d', '91_365d', '365d_plus']),
  ...categorical('contentLengthBucket', 'Content length', ['xs', 's', 'm', 'l', 'xl']),
  ...categorical('headingHierarchy', 'Heading hierarchy', ['none', 'flat', 'structured']),
  ...categorical('directAnswerPresence', 'Direct answer', ['absent', 'present']),
  ...categorical('faqStructure', 'FAQ structure', ['absent', 'present']),
  ...categorical('structuredDataPresence', 'Structured data', ['absent', 'present']),
  { key: 'citationMarkerCount', description: 'Citation marker count', kind: 'numeric', bounded: '0..1000' },
  { key: 'approvedAuthoritySourceCount', description: 'Approved authority source count', kind: 'numeric', bounded: '0..1000' },
  { key: 'evidenceUtilizationRatio', description: 'Evidence utilization ratio', kind: 'numeric', bounded: '0..1' },
  { key: 'entityCoverage', description: 'Entity coverage', kind: 'numeric', bounded: '0..1' },
  { key: 'selectedAutoGeoRuleCount', description: 'Selected AutoGEO rule count', kind: 'numeric', bounded: '0..128' },
  { key: 'appliedAutoGeoRuleCount', description: 'Applied AutoGEO rule count', kind: 'numeric', bounded: '0..128' },
  ...categorical('canonicalFlag', 'Canonical flag', ['valid', 'invalid']),
  ...categorical('indexabilityFlag', 'Indexability flag', ['indexable', 'not_indexable']),
  ...categorical('internalLinkDepthBucket', 'Internal link depth', ['0', '1', '2', '3_plus']),
  ...categorical('contentFreshnessBucket', 'Freshness', ['stale', 'recent', 'fresh']),
  { key: 'queryPageLexicalOverlap', description: 'Query/page lexical overlap', kind: 'numeric', bounded: '0..1' },
  ...categorical('topicClusterEqual', 'Topic cluster equality', ['no', 'yes']),
  { key: 'verifiedPublicationAgeDays', description: 'Verified publication age', kind: 'numeric', bounded: '0..100000' },
  { key: 'priorObservationCount', description: 'Prior observation count', kind: 'numeric', bounded: '0..1000000' },
  ...categorical('engine', 'Engine', ['chatgpt', 'gemini', 'claude', 'perplexity', 'google_ai_overview', 'other']),
  ...categorical('interface', 'Interface', ['consumer_surface', 'provider_api', 'search_surface', 'other']),
] as const

export const featureCatalogVersion = GEO_OUTCOME_FEATURE_CATALOG_VERSION

function numeric(values: FeatureValue[], key: string, value: number | null, scale = 1) {
  const missing = value === null || value === undefined
  values.push({ key, value: missing ? 0 : value / scale, missing })
}
function oneHot(values: FeatureValue[], key: string, current: string, unknown = 'unknown') {
  values.push({ key, value: current === unknown ? 0 : current === key.split('=')[1] ? 1 : 0, missing: current === unknown })
}

export function deriveFeatureVector(observation: OutcomeObservation): FeatureVector {
  const f = observation.contentFeatureVector
  const values: FeatureValue[] = []
  for (const definition of FEATURE_CATALOG) {
    const [root, expected] = definition.key.split('=')
    if (root === 'contentType' || root === 'locale' || root === 'pageAgeBucket' || root === 'contentLengthBucket' || root === 'headingHierarchy' || root === 'directAnswerPresence' || root === 'faqStructure' || root === 'structuredDataPresence' || root === 'canonicalFlag' || root === 'indexabilityFlag' || root === 'internalLinkDepthBucket' || root === 'contentFreshnessBucket' || root === 'topicClusterEqual') {
      oneHot(values, definition.key, f[root as keyof typeof f] as string, 'unknown')
    } else if (root === 'engine') {
      oneHot(values, definition.key, observation.engine)
    } else if (root === 'interface') {
      oneHot(values, definition.key, observation.interface)
    } else {
      const source = root === 'selectedAutoGeoRuleCount' ? f.selectedAutoGeoRuleHashes.length : root === 'appliedAutoGeoRuleCount' ? f.appliedAutoGeoRuleHashes.length : f[root as keyof typeof f]
      const scale = root === 'citationMarkerCount' || root === 'approvedAuthoritySourceCount' ? 10 : root === 'verifiedPublicationAgeDays' ? 365 : root === 'priorObservationCount' ? 100 : 1
      numeric(values, definition.key, typeof source === 'number' ? source : source === null ? null : null, scale)
    }
  }
  if (values.length > MAX_FEATURES) throw new Error('Feature catalog exceeds bounded feature count.')
  return { catalogVersion: GEO_OUTCOME_FEATURE_CATALOG_VERSION, values }
}

export function featureKeys(): string[] {
  return FEATURE_CATALOG.map(feature => feature.key)
}
