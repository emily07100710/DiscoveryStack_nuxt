import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath = new URL('../server/database/migrations/0025_aberrant_wallow.sql', import.meta.url)
const sql = readFileSync(migrationPath, 'utf8')

function position(fragment: string): number {
  const index = sql.indexOf(fragment)
  expect(index, `missing migration fragment: ${fragment}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('managed-site migration 0025 compatibility contract', () => {
  it('uses nullable transitional additions before deterministic backfill and final not-null tightening', () => {
    const addOwner = position('ALTER TABLE `managedSitePaymentEvents` ADD `ownerUserId` int;')
    const addQuoteKey = position('ALTER TABLE `managedSiteQuotes` ADD `idempotencyKey` varchar(128);')
    const projectBackfill = position('UPDATE `managedSiteProjects` SET `creationIdempotencyKey` = CONCAT(\'legacy-project-\', `id`)')
    const quoteBackfill = position('UPDATE `managedSiteQuotes` SET `idempotencyKey` = CONCAT(\'legacy-quote-\', `id`)')
    const paymentBackfill = position('UPDATE `managedSitePaymentEvents` AS pe')
    const paymentGuard = position('_managed_site_0025_payment_owner_guard')
    const finalProject = position('ALTER TABLE `managedSiteProjects` MODIFY COLUMN `creationIdempotencyKey` varchar(128) NOT NULL;')
    const finalPayment = position('ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `ownerUserId` int NOT NULL;')
    expect(addOwner).toBeLessThan(paymentBackfill)
    expect(addQuoteKey).toBeLessThan(quoteBackfill)
    expect(projectBackfill).toBeLessThan(finalProject)
    expect(quoteBackfill).toBeLessThan(finalProject)
    expect(paymentBackfill).toBeLessThan(paymentGuard)
    expect(paymentGuard).toBeLessThan(finalPayment)
  })

  it('backfills only from deterministic project/order/preview/quote/lead/user lineage and aborts unresolved rows', () => {
    expect(sql).toContain('COALESCE(d.`ownerUserId`, o.`ownerUserId`, p.`ownerUserId`)')
    expect(sql).toContain('COALESCE(pe.`ownerUserId`, o.`ownerUserId`, q.`ownerUserId`, p.`ownerUserId`, u.`id`)')
    expect(sql).toContain('WHERE `ownerUserId` IS NULL OR `previewId` IS NULL OR `quoteId` IS NULL')
    expect(sql).toContain('_managed_site_0025_domain_owner_guard')
    expect(sql).toContain('_managed_site_0025_payment_owner_guard')
    expect(sql).toContain("pe.`verificationStatus` = 'rejected'")
    expect(sql).not.toContain('legacy authority')
  })

  it('adds final owner-scoped keys only after backfill and removes old global keys', () => {
    for (const index of [
      'managed_site_domain_intents_owner_idempotency_unique',
      'managed_site_provisioning_plans_owner_intent_unique',
      'managed_site_provisioning_plans_owner_idempotency_unique',
      'managed_site_integrations_owner_intent_unique',
      'managed_site_integrations_owner_idempotency_unique',
      'managed_site_integrations_owner_shop_domain_unique',
      'managed_site_payment_events_owner_provider_event_unique',
      'managed_site_payment_events_fingerprint_unique',
    ]) expect(sql).toContain(index)
    for (const oldIndex of [
      'managed_site_domain_intents_idempotency_unique',
      'managed_site_provisioning_plans_intent_unique',
      'managed_site_provisioning_plans_idempotency_unique',
      'managed_site_integrations_intent_unique',
      'managed_site_integrations_idempotency_unique',
      'managed_site_integrations_shop_domain_unique',
    ]) expect(sql).not.toContain(`ADD CONSTRAINT \`${oldIndex}\``)
    expect(position('managed_site_integrations_owner_idempotency_unique')).toBeGreaterThan(position('_managed_site_0025_payment_owner_guard'))
  })

  it('does not require legacy Shopify nonce or code verifier credentials', () => {
    expect(sql).toContain('`nonceHash` varchar(128),')
    expect(sql).toContain('`codeVerifierHash` varchar(128),')
    expect(sql).not.toContain('`nonceHash` varchar(128) NOT NULL')
    expect(sql).not.toContain('`codeVerifierHash` varchar(128) NOT NULL')
  })
})
