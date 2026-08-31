import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath = new URL('../server/database/migrations/0025_aberrant_wallow.sql', import.meta.url)
const schemaPath = new URL('../server/database/schema.ts', import.meta.url)
const sql = readFileSync(migrationPath, 'utf8')
const schema = readFileSync(schemaPath, 'utf8')

function position(fragment: string): number {
  const index = sql.indexOf(fragment)
  expect(index, `missing migration fragment: ${fragment}`).toBeGreaterThanOrEqual(0)
  return index
}

function sha256(path: URL): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const legacyMigrationHashes: Record<string, string> = {
  '0021_omniscient_sebastian_shaw.sql': '263ef27966f15c57e00c019f85c95466b50107dbc412f98426c2c7e2ea58c690',
  '0022_even_tiger_shark.sql': '76b4748b234f50c53a7a459011d9a1c2de243abfaf7ecc46edacc7c72d214c1d',
  '0023_smooth_spot.sql': 'a3f1661e5bf9440f7382171f24e486c195afe2d513a986584d7fd60d68aea28a',
  '0024_nice_obadiah_stane.sql': 'df7032887970a4f2aca67b3bb9ad79ef324a63f4e48dc5ad273c4555fb14a0e8',
}

describe('managed-site migration 0025 compatibility contract', () => {
  it('runs all old-schema preflight guards before the first destructive or implicit-commit DDL', () => {
    const preflightStart = position('CREATE TEMPORARY TABLE `_managed_site_0025_preflight_guard`')
    const preflightEnd = position('DROP TEMPORARY TABLE `_managed_site_0025_preflight_guard`')
    const firstDestructive = Math.min(...['DROP INDEX', 'ALTER TABLE'].map(fragment => position(fragment)))
    expect(preflightStart).toBeLessThan(firstDestructive)
    expect(preflightEnd).toBeLessThan(firstDestructive)
    expect(sql.slice(preflightStart, preflightEnd)).toContain('managedSiteDomainIntents')
    expect(sql.slice(preflightStart, preflightEnd)).toContain('managedSitePaymentEvents')
    expect(sql.slice(preflightStart, preflightEnd)).toContain('payment_event_collisions')
    expect(sql.slice(preflightStart, preflightEnd)).toContain('domain_idempotency_collisions')
    expect(sql.slice(preflightStart, preflightEnd)).toContain('integration_shop_collisions')
  })

  it('never uses lead rows or user email to infer payment ownership', () => {
    expect(sql).not.toContain('`leads`')
    expect(sql).not.toMatch(/JOIN\s+leads\b/iu)
    expect(sql).not.toMatch(/JOIN\s+users\b[^;]*email/isu)
    expect(sql).toContain('INNER JOIN `managedSiteDraftOrders` AS o')
    expect(sql).toContain('INNER JOIN `managedSiteQuotes` AS q')
    expect(sql).toContain('INNER JOIN `managedSitePreviews` AS p')
    expect(sql).toContain('COALESCE(pe.`ownerUserId`, o.`ownerUserId`, q.`ownerUserId`, p.`ownerUserId`)')
    expect(sql).toContain("pe.`verificationStatus` = 'rejected'")
    expect(sql).toContain('OR (o.`ownerUserId` IS NULL AND q.`ownerUserId` IS NULL AND p.`ownerUserId` IS NULL)')
  })

  it('performs additive schema and deterministic backfill before second guards, tightening, FKs, and replacement keys', () => {
    const additive = position('ALTER TABLE `managedSitePaymentEvents` ADD `ownerUserId` int;')
    const paymentBackfill = position('UPDATE `managedSitePaymentEvents` AS pe')
    const secondGuard = position('CREATE TEMPORARY TABLE `_managed_site_0025_backfill_guard`')
    const notNull = position('ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `ownerUserId` int NOT NULL;')
    const firstForeignKey = position('ADD CONSTRAINT `managedSitePaymentEvents_ownerUserId_users_id_fk`')
    const firstReplacementKey = position('ADD CONSTRAINT `managed_site_draft_orders_preview_idempotency_unique`')
    const firstGlobalDrop = position('DROP INDEX `managed_site_draft_orders_idempotency_unique`')
    expect(additive).toBeLessThan(paymentBackfill)
    expect(paymentBackfill).toBeLessThan(secondGuard)
    expect(secondGuard).toBeLessThan(notNull)
    expect(notNull).toBeLessThan(firstReplacementKey)
    expect(firstReplacementKey).toBeLessThan(firstForeignKey)
    expect(firstForeignKey).toBeLessThan(firstGlobalDrop)
    expect(sql).toContain('_managed_site_0025_backfill_guard')
    expect(sql).toContain('GROUP BY `ownerUserId`, `providerKey`, `eventId` HAVING COUNT(*) > 1')
    expect(sql).toContain('GROUP BY `ownerUserId`, `eventFingerprint` HAVING COUNT(*) > 1')
  })

  it('contains every owner-scoped unique key declared by schema.ts', () => {
    const keys = [
      'managed_site_projects_owner_creation_idempotency_unique',
      'managed_site_quotes_preview_idempotency_unique',
      'managed_site_lead_intents_preview_idempotency_unique',
      'managed_site_draft_orders_preview_idempotency_unique',
      'managed_site_payment_events_owner_provider_event_unique',
      'managed_site_payment_events_fingerprint_unique',
      'managed_site_domain_intents_owner_idempotency_unique',
      'managed_site_provisioning_plans_owner_intent_unique',
      'managed_site_provisioning_plans_owner_idempotency_unique',
      'managed_site_integrations_owner_intent_unique',
      'managed_site_integrations_owner_idempotency_unique',
      'managed_site_integrations_owner_shop_domain_unique',
    ]
    for (const key of keys) {
      expect(sql).toContain(key)
      expect(schema).toContain(`uniqueIndex('${key}')`)
    }
    expect(sql).not.toContain('ADD CONSTRAINT `managed_site_integrations_intent_unique`')
    expect(sql).not.toContain('ADD CONSTRAINT `managed_site_integrations_idempotency_unique`')
  })

  it('freezes 0021-0024 after the pre-production identifier correction', () => {
    for (const [filename, expectedHash] of Object.entries(legacyMigrationHashes)) {
      const path = new URL(`../server/database/migrations/${filename}`, import.meta.url)
      expect(sha256(path), filename).toBe(expectedHash)
    }
  })

  it('keeps legacy Shopify nonce and code-verifier columns nullable for compatibility', () => {
    expect(sql).toContain('`nonceHash` varchar(128),')
    expect(sql).toContain('`codeVerifierHash` varchar(128),')
    expect(sql).not.toContain('`nonceHash` varchar(128) NOT NULL')
    expect(sql).not.toContain('`codeVerifierHash` varchar(128) NOT NULL')
  })
})
