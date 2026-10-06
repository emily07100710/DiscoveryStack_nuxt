import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildManagedSiteMediaStorageRequest, projectManagedSiteMediaSetupStatus } from '../utils/managedSiteMediaSetup'

const page = readFileSync(new URL('../pages/audit-lab/managed-sites/media.vue', import.meta.url), 'utf8')
const parent = readFileSync(new URL('../pages/audit-lab/managed-sites.vue', import.meta.url), 'utf8')
const setup = readFileSync(new URL('../pages/audit-lab/managed-sites/setup.vue', import.meta.url), 'utf8')

describe('managed-site media setup projection', () => {
  it('builds only redacted S3 metadata and normalizes the object prefix', () => {
    const result = buildManagedSiteMediaStorageRequest({
      credentialReference: ' DS_MEDIA_S3_CREDENTIAL ',
      bucket: 'discoverystack-media-prod',
      region: 'auto',
      prefix: 'managed-sites/media/',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      publicCdnOrigin: '',
    })
    expect(result).toEqual({
      ok: true,
      credentialReference: 'DS_MEDIA_S3_CREDENTIAL',
      configuration: {
        bucket: 'discoverystack-media-prod',
        region: 'auto',
        prefix: 'managed-sites/media',
        endpoint: 'https://account.r2.cloudflarestorage.com',
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/accessKeyId|secretAccessKey|sessionToken|bearer/iu)
  })

  it('rejects credential values, traversal-like prefixes, and non-origin endpoints in the browser guard', () => {
    const base = { credentialReference: 'DS_MEDIA_S3_CREDENTIAL', bucket: 'discoverystack-media-prod', region: 'auto', prefix: 'media', endpoint: '', publicCdnOrigin: '' }
    expect(buildManagedSiteMediaStorageRequest({ ...base, credentialReference: 'AKIA-not-a-reference' })).toMatchObject({ ok: false })
    expect(buildManagedSiteMediaStorageRequest({ ...base, prefix: '../media' })).toMatchObject({ ok: false })
    expect(buildManagedSiteMediaStorageRequest({ ...base, endpoint: 'https://storage.example.com/private/path' })).toMatchObject({ ok: false })
    expect(buildManagedSiteMediaStorageRequest({ ...base, endpoint: 'http://storage.example.com' })).toMatchObject({ ok: false })
  })

  it('keeps storage readiness separate from scanner quarantine', () => {
    expect(projectManagedSiteMediaSetupStatus(false, null)).toEqual({ configuration: 'not_checked', storage: 'not_checked', scanner: 'not_checked' })
    expect(projectManagedSiteMediaSetupStatus(true, {
      status: 'verified',
      health: { ready: true, mode: 's3-compatible-verified' },
      scannerHealth: { ready: false, mode: 'scanner-not-configured', reason: 'SCANNER_NOT_CONFIGURED' },
    })).toEqual({ configuration: 'configured', storage: 'verified', scanner: 'quarantined' })
    expect(projectManagedSiteMediaSetupStatus(true, {
      status: 'blocked',
      health: { ready: false, mode: 's3-compatible-blocked', reason: 'health_request_failed' },
      scannerHealth: { ready: true, mode: 'scanner-known-fixture-verified' },
    })).toEqual({ configuration: 'configured', storage: 'blocked', scanner: 'verified' })
  })
})

describe('owner media setup page contract', () => {
  it('uses the existing owner-only project, configure, and health endpoints', () => {
    for (const endpoint of [
      '/api/managed-sites/projects',
      '/api/managed-sites/editor/storage-connections',
      '/api/managed-sites/editor/storage-connections/health',
    ]) expect(page).toContain(endpoint)
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!)
    expect(apiLiterals).toHaveLength(3)
    expect(page).toContain("providerKey: 's3_compatible'")
    expect(page).toContain("body: { projectId: selectedId.value }")
    expect(parent).toContain('to="/audit-lab/managed-sites/media"')
    expect(setup).toContain('to="/audit-lab/managed-sites/media"')
  })

  it('never asks the browser for storage or scanner credential values', () => {
    expect(page).toContain('這個表單不接受 access key、secret key、session token 或 scanner bearer token')
    expect(page).toContain('這是 server env 名稱，不是 credential 值。')
    expect(page).not.toMatch(/v-model="[^"]*(?:accessKey|secretAccess|sessionToken|scannerToken|bearer)[^"]*"/iu)
    expect(page).not.toContain('type="password"')
    expect(page).toContain('<code>NUXT_MEDIA_SCANNER_ENDPOINT</code>')
    expect(page).toContain('<code>NUXT_MEDIA_SCANNER_CREDENTIAL_REF</code>')
  })

  it('shows truthful configured, verified, blocked, and quarantine states', () => {
    for (const token of ['已保存，待驗證', '已驗證', '驗證失敗', '隔離模式', '尚未檢查']) expect(page).toContain(token)
    expect(page).toContain('設定存在不等於已驗證')
    expect(page).toContain('上傳內容會留在隔離區，不會公開')
    expect(page).toContain('重新保存會清除舊的 storage 與 scanner health receipt')
    expect(page).toContain('沒有 readiness receipt 被推定')
  })

  it('requires explicit acknowledgement before real bounded health checks', () => {
    expect(page).toContain('healthConfirmed')
    expect(page).toContain('我了解這會對 S3/R2 與已設定的 scanner 發出真實、有限的健康檢查。')
    expect(page).toContain(':disabled="!selectedProject || !healthConfirmed || busy !== null"')
    expect(page).toContain('它不會上傳客戶素材')
    for (const forbidden of ['v-html', "from '../../../server/", 'TODO']) expect(page).not.toContain(forbidden)
  })
})
