import { MARKET_SIGNAL_ENGINE_VERSION, MARKET_SIGNAL_POLICY_VERSION } from './types'
import type { MarketSignalPolicy, SignalProvider } from './types'

export { MARKET_SIGNAL_ENGINE_VERSION, MARKET_SIGNAL_POLICY_VERSION }

export const MARKET_SIGNAL_POLICIES: Record<SignalProvider, MarketSignalPolicy> = {
  google_trends: {
    provider: 'google_trends',
    allowedClaimUses: ['market_hypothesis'],
    maxSnapshots: 12,
    maxObservationsPerSnapshot: 366,
    maxAdsPerSnapshot: 0,
  },
  meta_ad_library: {
    provider: 'meta_ad_library',
    allowedClaimUses: ['market_hypothesis'],
    maxSnapshots: 12,
    maxObservationsPerSnapshot: 0,
    maxAdsPerSnapshot: 2_000,
  },
}

export const MIN_TREND_OBSERVATIONS = 2
export const MIN_META_SNAPSHOTS_FOR_DIRECTION = 2
export const MAX_REQUEST_ID_LENGTH = 120
export const MAX_LIMITATION_LENGTH = 240

export const MARKET_SIGNAL_LIMITATIONS = [
  '這是 bounded market signal，不是市場規模、搜尋量、因果關係或事實真值。',
  'Google Trends 只表示相對興趣；它不能單獨支持 factual claim、排名、曝光、流量、ROI 或投資決策。',
  'Meta Ad Library snapshot 只表示觀察到的廣告活動；它不能單獨支持產品品質、市占率、轉換率或競品事實。',
  '本 engine 只處理傳入 metadata，不會 scraping、發出 Google／Meta request、呼叫 provider 或保存全文。',
  '輸出需要 human review；metrics 是治理與排序訊號，不是 truth score。',
] as const
