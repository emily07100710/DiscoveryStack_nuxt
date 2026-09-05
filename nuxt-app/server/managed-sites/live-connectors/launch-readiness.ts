import type { SiteModule } from '../site-spec'
import type { ManagedSiteLiveConnectorRepository, ManagedSiteProviderCapability } from './types'

export type LaunchReadinessBlocker = {
  code: string
  capability?: ManagedSiteProviderCapability
  providerKey?: string
  moduleKey?: SiteModule
  messageZh: string
}

const NON_PRODUCTION_IDENTITY = /(?:^|[:/_-])(?:test|stage|staging|sandbox)(?:$|[:/_-])/iu

function providerLabel(providerKey: string): string {
  if (providerKey === 'stripe') return 'Stripe'
  if (providerKey === 'porkbun') return 'Porkbun'
  return providerKey
}

export async function evaluateManagedSiteLaunchReadiness(
  ownerUserId: number,
  repository: Pick<ManagedSiteLiveConnectorRepository, 'listProviderConfigurations' | 'listPendingManualModuleFulfilments'>,
): Promise<{ ready: boolean; blockers: LaunchReadinessBlocker[] }> {
  const [configurations, pendingManual] = await Promise.all([
    repository.listProviderConfigurations(ownerUserId),
    repository.listPendingManualModuleFulfilments(ownerUserId),
  ])
  const blockers: LaunchReadinessBlocker[] = []
  for (const configuration of configurations) {
    if (configuration.readinessStatus !== 'verified' || !configuration.capabilityIdentity) continue
    if (configuration.capability === 'payment' && NON_PRODUCTION_IDENTITY.test(configuration.capabilityIdentity)) {
      blockers.push({ code: 'payment_provider_non_production', capability: 'payment', providerKey: configuration.providerKey, messageZh: `${providerLabel(configuration.providerKey)} 付款服務仍為測試環境。` })
    }
    if (configuration.capability === 'domain_registration' && configuration.providerKey === 'porkbun' && configuration.capabilityIdentity === 'porkbun:sandbox') {
      blockers.push({ code: 'domain_provider_sandbox', capability: 'domain_registration', providerKey: configuration.providerKey, messageZh: 'Porkbun 網域註冊仍為沙盒環境。' })
    }
  }
  for (const fulfilment of pendingManual) {
    blockers.push({ code: 'module_pending_manual_setup', moduleKey: fulfilment.moduleKey as SiteModule, messageZh: `模組 ${fulfilment.moduleKey} 已付款，仍待客服開通。` })
  }
  return { ready: blockers.length === 0, blockers }
}

export function isManagedSiteProductionPaymentIdentity(providerKey: string, capabilityIdentity: string): boolean {
  return providerKey === 'stripe' ? capabilityIdentity === 'stripe-balance:live' : /(?:^|[:/_-])(?:live|production)(?:$|[:/_-])/iu.test(capabilityIdentity)
}
