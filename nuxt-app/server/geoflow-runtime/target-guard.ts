import { validatePublicHttpsUrl } from '../geoflow-integration'
import type { GeoFlowTransportResult } from './types'

const TASK_ID_MAX = 2_147_483_647

function failure(code: 'TARGET_INVALID' | 'TASK_ID_INVALID'): GeoFlowTransportResult<never> {
  return { ok: false, error: { code, retryable: false } }
}

export function validateGeoFlowBaseUrl(value: unknown): GeoFlowTransportResult<string> {
  const validated = validatePublicHttpsUrl(value, '$.target.baseUrl')
  if (!validated.ok) return failure('TARGET_INVALID')
  try {
    const url = new URL(validated.value)
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port !== '') return failure('TARGET_INVALID')
    return { ok: true, value: url.origin }
  } catch {
    return failure('TARGET_INVALID')
  }
}

export function validateGeoFlowTaskId(value: unknown): GeoFlowTransportResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > TASK_ID_MAX) return failure('TASK_ID_INVALID')
  return { ok: true, value: value as number }
}

export function joinGeoFlowPath(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`
}
