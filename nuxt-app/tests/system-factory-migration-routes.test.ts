import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(process.cwd(), 'server/database/migrations/0031_pale_the_fury.sql'), 'utf8')
const expectedTables = ['systemSpecs', 'systemSpecVersions', 'systemPreviews', 'systemTenants', 'systemTenantBindings', 'systemProvisioningPlans', 'systemProvisioningRuns', 'systemProvisioningAttempts', 'systemEvents', 'systemReceipts', 'systemAdminInvitations', 'systemConnectionRefs', 'systemUpgradeIntents', 'systemUpgradeRuns', 'systemUpgradeReceipts']

function files(directory: string): string[] { return readdirSync(directory).flatMap(entry => { const path = join(directory, entry); return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [] }) }

describe('System Factory migration and route contracts', () => {
  it('generates all durable tables without destructive SQL or production apply', () => { for (const table of expectedTables) expect(migration).toContain(`CREATE TABLE \`${table}\``); expect(migration).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE\s+FROM)\b/imu); expect(migration).toContain('systemTenantBindings_managedSitePaymentEventId_managedSitePaymentEvents_id_fk') })
  it('keeps append-only event/receipt ledgers and hashed invitations', () => { expect(migration).toContain('`authorityFingerprint` varchar(64) NOT NULL'); expect(migration).toContain('`receiptFingerprint` varchar(64) NOT NULL'); expect(migration).toContain('`tokenHash` varchar(64) NOT NULL'); expect(migration).not.toMatch(/`token`\s|`password`\s|administratorPassword/iu) })
  it('owner mutation routes require owner context, strict body and same-origin policy', () => { const root = join(process.cwd(), 'server/api/system-factory'); expect(existsSync(root)).toBe(true); const mutationRoutes = files(root).filter(file => file.endsWith('.post.ts') && !file.endsWith('invitations/accept.post.ts')); expect(mutationRoutes.length).toBeGreaterThanOrEqual(8); for (const file of mutationRoutes) { const source = readFileSync(file, 'utf8'); expect(source, relative(process.cwd(), file)).toContain('systemFactoryOwnerContext(event, true)'); expect(source, relative(process.cwd(), file)).toContain('strictSystemFactoryBody') } })
  it('customer routes stay private and do not expose credentials or provenance', () => { const source = readFileSync(join(process.cwd(), 'server/api/system-factory/customer/status.get.ts'), 'utf8'); expect(source).toContain('requireManagedSiteCustomer'); expect(source).toContain('private, no-store'); expect(source).not.toMatch(/credentialReference|UPSTREAM|Administrator password/iu); const acceptance = readFileSync(join(process.cwd(), 'server/api/system-factory/invitations/accept.post.ts'), 'utf8'); expect(acceptance).toContain('assertSameOriginMutation(event)'); expect(acceptance).toContain('strictSystemFactoryBody') })
})
