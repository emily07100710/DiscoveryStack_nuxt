import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('managed-site live connectors durable and private contracts', () => {
  it('keeps all routes owner-only except the signature-first provider webhook', () => {
    for (const route of [
      'server/api/managed-sites/live-connectors/readiness.get.ts',
      'server/api/managed-sites/live-connectors/provider-configurations.post.ts',
      'server/api/managed-sites/live-connectors/workspace.get.ts',
      'server/api/managed-sites/projects/[id]/live-generation.post.ts',
      'server/api/managed-sites/projects/[id]/live-orchestration.post.ts',
    ]) {
      const source = read(route)
      expect(source).toContain('requireOwner(event)')
      expect(source).toContain('getOwnerDatabaseUserId(owner.openId)')
    }
    const webhook = read('server/api/managed-sites/live-connectors/payment-webhook.post.ts')
    expect(webhook).toContain('readRawBody(event, false)')
    expect(webhook).not.toContain('readBody(')
    expect(webhook).toContain('processManagedSiteRawPaymentWebhook')
  })

  it('adds DDL-only durable tables with owner/project/order scope, immutable receipts, and collision indexes', () => {
    const migration = read('server/database/migrations/0026_reflective_killmonger.sql')
    for (const table of ['managedSiteProviderConfigurations', 'managedSiteGenerationCandidates', 'managedSiteReleaseProjections', 'managedSiteConnectorAttempts', 'managedSiteConnectorReceipts']) expect(migration).toContain(`CREATE TABLE \`${table}\``)
    expect(migration).toContain('managed_site_connector_attempt_owner_idempotency_unique')
    expect(migration).toContain('managed_site_connector_receipt_provider_event_unique')
    expect(migration).toContain('managed_site_release_project_target_content_unique')
    expect(migration).toContain('FOREIGN KEY (`draftOrderId`)')
    expect(migration).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/imu)
  })

  it('renders truthful owner readiness without credential values or public customer controls', () => {
    const page = read('pages/audit-lab/managed-sites.vue')
    expect(page).toContain('configured 仍不代表 verified')
    expect(page).toContain('真正 credential 只能由 server runtime registry 注入')
    expect(page).toContain('Generation dry-run')
    expect(page).toContain('下一安全動作')
    expect(page).not.toMatch(/API key[^<]*<input/iu)
    expect(page).not.toContain('已付款成功')
    expect(page).not.toContain('已部署成功')
    expect(read('layouts/owner.vue')).toContain('/audit-lab/managed-sites')
  })

  it('keeps exact live receipt authority and GEO activation gates in the single orchestrator', () => {
    const source = read('server/managed-sites/live-connectors/deployment-orchestrator.ts')
    expect(source).toContain("receiptType === 'preview_build_verified'")
    expect(source).toContain("receiptType === 'owner_preview_approved'")
    expect(source).toContain("receiptType === 'release_payment_bound'")
    expect(source).toContain("receiptType === 'dns_tls_verified'")
    expect(source).toContain("receiptType: 'production_deployment_verified'")
    expect(source).toContain("['production_deployment_verified', 'existing_site_ownership_verified']")
    expect(source).toContain('linkManagedSiteContentOperations')
    expect(source).toContain('measurementStartsAfterVerifiedLiveSite: true')
  })
})
