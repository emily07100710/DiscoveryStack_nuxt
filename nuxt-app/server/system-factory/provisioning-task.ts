import { getDatabase } from '../database'
import { SystemFactoryError } from './canonical'
import { createReviewedBenchControlPlaneAdapter, type ReviewedBenchTransport, type SystemFactoryControlPlanePort } from './control-plane'
import { createTenantAppAdapter, type TenantAppPort } from './frappe-adapter'
import { createSystemFactoryProvisioner } from './provisioner'
import { DrizzleProvisioningRepository } from './provisioning-repository-drizzle'
import { runProvisioningTick, type DurableProvisioningRepositoryPort } from './provisioning-scheduler'
import { runtimeAuthorityFromEnvironment } from './runtime-authority'

export async function executeProvisioningTask(input: { enabled: boolean; repository?: DurableProvisioningRepositoryPort; controlPlane?: SystemFactoryControlPlanePort; tenantApp?: TenantAppPort; workerId?: string } = { enabled: false }) {
  if (!input.enabled) return { enabled: false, claimed: 0, executed: 0, limitation: 'Server provisioning execution is disabled.' }
  const authority = runtimeAuthorityFromEnvironment(); const database = getDatabase()
  if (!input.repository && !database) return { enabled: true, claimed: 0, executed: 0, blocked: 0, limitation: 'Durable provisioning database is unavailable.' }
  const unavailableTransport: ReviewedBenchTransport = { async execute() { throw new SystemFactoryError('CONTROL_PLANE_TRANSPORT_UNAVAILABLE', 'Reviewed bench/container transport is not injected.', 503) } }
  const controlPlane = input.controlPlane || createReviewedBenchControlPlaneAdapter({ liveEnabled: process.env.SYSTEM_FACTORY_CONTROL_PLANE_LIVE_ENABLED === 'true', expectedAuthorityFingerprint: process.env.SYSTEM_FACTORY_RUNTIME_AUTHORITY_FINGERPRINT, transport: unavailableTransport })
  const endpointOrigin = process.env.SYSTEM_FACTORY_FRAPPE_ORIGIN || 'https://unconfigured.invalid'; const allowedOrigins = (process.env.SYSTEM_FACTORY_FRAPPE_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  const tenantApp = input.tenantApp || createTenantAppAdapter({ endpointOrigin, allowedOrigins, sender: 'discoverystack-nuxt', receiver: 'discovery-stack-frappe-app', keyId: process.env.SYSTEM_FACTORY_HMAC_KEY_ID || 'unconfigured', liveEnabled: process.env.SYSTEM_FACTORY_TENANT_APP_LIVE_ENABLED === 'true', expectedAuthorityFingerprint: process.env.SYSTEM_FACTORY_RUNTIME_AUTHORITY_FINGERPRINT, credentialResolver: async reference => reference === process.env.SYSTEM_FACTORY_HMAC_CREDENTIAL_REF && process.env.SYSTEM_FACTORY_HMAC_SECRET && process.env.SYSTEM_FACTORY_FRAPPE_AUTHORIZATION ? { ok: true, value: { hmacKey: process.env.SYSTEM_FACTORY_HMAC_SECRET, authorizationHeader: process.env.SYSTEM_FACTORY_FRAPPE_AUTHORIZATION } } : { ok: false, reason: 'missing' } })
  return runProvisioningTick({ repository: input.repository || new DrizzleProvisioningRepository(database!, authority), provisioner: createSystemFactoryProvisioner({ controlPlane, tenantApp }), workerId: input.workerId || `nitro-${process.pid}`, maxTenants: 20, maxStepsPerTenant: 10, maxTotalSteps: 100 })
}
