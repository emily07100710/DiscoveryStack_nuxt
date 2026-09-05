import { createError } from 'h3'
import type { ManagedSiteModuleFulfilment, ManagedSiteQuote, ManagedSiteQuoteLine } from '../../database/schema'
import { MODULE_CATALOG } from '../ordering-service'
import { SITE_MODULES, type SiteModule } from '../site-spec'
import { managedSiteBlueprintModuleMode } from '../live-connectors/blueprint'

export type ManagedSiteModuleFulfilmentRepository = {
  findModuleFulfilment(ownerUserId: number, draftOrderId: number, moduleKey: SiteModule): Promise<ManagedSiteModuleFulfilment | null>
  insertModuleFulfilment(input: Omit<ManagedSiteModuleFulfilment, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteModuleFulfilment>
  listModuleFulfilmentsByDraftOrder(ownerUserId: number, draftOrderId: number): Promise<ManagedSiteModuleFulfilment[]>
  listPendingManualModuleFulfilments(ownerUserId: number): Promise<ManagedSiteModuleFulfilment[]>
  closePendingManualModuleFulfilment(ownerUserId: number, draftOrderId: number, moduleKey: SiteModule, completedAt: Date): Promise<ManagedSiteModuleFulfilment | null>
}

/** Catalog activation remains canonical; an inert generated slot can only downgrade to manual service. */
export function managedSiteModuleFulfilmentMode(moduleKey: SiteModule): 'automatic' | 'manual_service' {
  const activation = MODULE_CATALOG[moduleKey].activation
  return activation === 'automatic' && managedSiteBlueprintModuleMode(moduleKey) === 'first_party' ? 'automatic' : 'manual_service'
}

function selectedModules(quote: Pick<ManagedSiteQuote, 'moduleSnapshot'>): SiteModule[] {
  if (!Array.isArray(quote.moduleSnapshot) || quote.moduleSnapshot.some(module => typeof module !== 'string' || !(SITE_MODULES as readonly string[]).includes(module))) {
    throw createError({ statusCode: 409, statusMessage: 'Quote module snapshot is invalid.' })
  }
  return [...new Set(quote.moduleSnapshot as SiteModule[])]
}

function billedModuleAmount(moduleKey: SiteModule, lines: readonly Pick<ManagedSiteQuoteLine, 'lineKey' | 'lineAmountMinor'>[]): number {
  return lines
    .filter(line => line.lineKey === `module-${moduleKey}-setup` || line.lineKey === `monthly-module-${moduleKey}`)
    .reduce((total, line) => total + line.lineAmountMinor, 0)
}

export async function createPaidManagedSiteModuleFulfilments(
  ownerUserId: number,
  draftOrderId: number,
  quote: Pick<ManagedSiteQuote, 'id' | 'moduleSnapshot'>,
  quoteLines: readonly Pick<ManagedSiteQuoteLine, 'lineKey' | 'lineAmountMinor'>[],
  repository: ManagedSiteModuleFulfilmentRepository,
): Promise<ManagedSiteModuleFulfilment[]> {
  const rows: ManagedSiteModuleFulfilment[] = []
  for (const moduleKey of selectedModules(quote as Pick<ManagedSiteQuote, 'moduleSnapshot'>)) {
    const mode = managedSiteModuleFulfilmentMode(moduleKey)
    const readiness = MODULE_CATALOG[moduleKey].readiness
    const expected = {
      ownerUserId,
      draftOrderId,
      quoteId: quote.id,
      moduleKey,
      mode,
      status: readiness === 'coming_soon' ? 'recorded_intent_unbilled' as const : readiness === 'manual_setup' ? 'pending_manual_setup' as const : 'automatic' as const,
      billedMinor: readiness === 'coming_soon' ? 0 : billedModuleAmount(moduleKey, quoteLines),
      customerVisibleStatus: readiness === 'coming_soon' ? '已登記需求・尚未開通（未收費）' : readiness === 'manual_setup' ? '已付款・待我們為你設定開通' : '已付款・由系統自動處理',
      ownerActionRequired: readiness !== 'available',
      completedAt: null,
    }
    const existing = await repository.findModuleFulfilment(ownerUserId, draftOrderId, moduleKey)
    if (existing) {
      if (existing.quoteId !== quote.id || existing.mode !== expected.mode || existing.billedMinor !== expected.billedMinor || existing.status !== expected.status && existing.status !== 'manual_setup_completed') {
        throw createError({ statusCode: 409, statusMessage: 'Module fulfilment lineage conflicts with the paid quote.' })
      }
      rows.push(existing)
      continue
    }
    rows.push(await repository.insertModuleFulfilment(expected))
  }
  return rows
}

export async function closeManagedSiteManualModuleFulfilment(
  ownerUserId: number,
  draftOrderId: number,
  moduleKey: SiteModule,
  repository: ManagedSiteModuleFulfilmentRepository,
  completedAt: Date = new Date(),
): Promise<ManagedSiteModuleFulfilment> {
  const row = await repository.closePendingManualModuleFulfilment(ownerUserId, draftOrderId, moduleKey, completedAt)
  if (!row) throw createError({ statusCode: 409, statusMessage: '待人工設定的模組不存在或已結案。' })
  return row
}
