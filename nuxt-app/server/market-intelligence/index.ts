import { calculateMetaMetrics, calculateTrendMetrics } from './metrics'
import { parseGoogleTrendsCsv, parseMetaAdSnapshot } from './normalization'

export {
  assessmentFingerprint,
  assessMarketSignal,
  isMarketSignalEnginePure,
} from './engine'
export {
  calculateMetaMetrics,
  calculateTrendMetrics,
} from './metrics'
export {
  fingerprint,
  isIsoDate,
  isIsoDateTime,
  isSha256Hex,
  normalizePublisherIdentity,
  normalizeText,
  parseGoogleTrendsCsv,
  parseMetaAdSnapshot,
  sha256,
  stableStringify,
} from './normalization'
export {
  MARKET_SIGNAL_LIMITATIONS,
  MARKET_SIGNAL_POLICIES,
  MARKET_SIGNAL_ENGINE_VERSION,
  MARKET_SIGNAL_POLICY_VERSION,
  MAX_LIMITATION_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MIN_META_SNAPSHOTS_FOR_DIRECTION,
  MIN_TREND_OBSERVATIONS,
} from './policy-catalog'
export * from './types'

export const parseGoogleTrends = parseGoogleTrendsCsv
export const parseMetaAdLibrarySnapshot = parseMetaAdSnapshot
export const calculateDeterministicTrendMetrics = calculateTrendMetrics
export const calculateDeterministicMetaMetrics = calculateMetaMetrics
