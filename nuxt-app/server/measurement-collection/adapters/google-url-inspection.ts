import { isRecord, normalizeSearchConsoleProperty } from '../normalization'
import type { AdapterFailure } from '../types'
import { GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, postFixedJson, resolveGoogleCredential, type GoogleRequestContext } from './google-shared'

export const URL_INSPECTION_ADAPTER_VERSION = 'gsc-url-inspection-v1'

const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export type UrlInspectionSuccess = {
  status: 'succeeded'
  property: string
  inspectionUrl: string
  lastCrawlTime: Date | null
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  pageFetchState: string | null
  robotsTxtState: string | null
  inspectedAt: Date
  limitations: string[]
}

export type UrlInspectionResult = UrlInspectionSuccess | AdapterFailure

function failure(code: string, limitations: string[]): AdapterFailure {
  return {
    status: 'failed',
    code,
    retryable: false,
    summary: code.replace(/_/gu, ' ').toLocaleLowerCase('en-US').slice(0, 240),
    limitations: [...new Set(['url_inspection_quota_limited', ...limitations])],
  }
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 120 ? value : null
}

function crawlTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !RFC_3339.test(value)) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

export async function inspectUrlWithSearchConsole(context: GoogleRequestContext, input: { inspectionUrl: string, siteUrl: string }): Promise<UrlInspectionResult> {
  const property = normalizeSearchConsoleProperty(input.siteUrl, context.connection.canonicalOrigin)
  if (!property) return failure('INVALID_SEARCH_CONSOLE_PROPERTY', ['search_console_property_not_configured'])

  const credential = await resolveGoogleCredential(context, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
  if ('failure' in credential) return { ...credential.failure, limitations: [...new Set(['url_inspection_quota_limited', ...credential.failure.limitations])] }

  const response = await postFixedJson(context, URL_INSPECTION_ENDPOINT, credential.credential, {
    inspectionUrl: input.inspectionUrl,
    siteUrl: property,
  })
  if (!response.ok) return { ...response.failure, limitations: [...new Set(['url_inspection_quota_limited', ...response.failure.limitations])] }

  const inspectionResult = isRecord(response.body) ? response.body.inspectionResult : undefined
  if (!isRecord(inspectionResult)) return failure('MALFORMED_RESPONSE', ['url_inspection_response_shape_invalid'])
  const indexStatusResult = isRecord(inspectionResult.indexStatusResult) ? inspectionResult.indexStatusResult : {}
  const lastCrawlTime = crawlTime(indexStatusResult.lastCrawlTime)
  const limitations = ['url_inspection_quota_limited']
  if (!lastCrawlTime) limitations.push('last_crawl_time_unavailable')

  return {
    status: 'succeeded',
    property,
    inspectionUrl: input.inspectionUrl,
    lastCrawlTime,
    verdict: boundedString(indexStatusResult.verdict),
    coverageState: boundedString(indexStatusResult.coverageState),
    indexingState: boundedString(indexStatusResult.indexingState),
    pageFetchState: boundedString(indexStatusResult.pageFetchState),
    robotsTxtState: boundedString(indexStatusResult.robotsTxtState),
    inspectedAt: context.now || new Date(),
    limitations,
  }
}
