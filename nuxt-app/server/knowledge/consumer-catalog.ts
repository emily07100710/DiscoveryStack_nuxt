import { assertValidKnowledgeConsumerAnchor } from './consumer-bindings'
import { KnowledgeConsumerBindingError, type KnowledgeConsumerCatalog, type KnowledgeConsumerKind, type KnowledgeConsumerBindingRepository } from './consumer-binding-types'

export const KNOWLEDGE_CONSUMER_CATALOG_PAGE_SIZE = 25
const fail = (code: ConstructorParameters<typeof KnowledgeConsumerBindingError>[0]): never => { throw new KnowledgeConsumerBindingError(code) }

export function parseKnowledgeConsumerCatalogQuery(input: unknown): { kind: KnowledgeConsumerKind, afterId: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_INPUT')
  const row = input as Record<string, unknown>
  if (Reflect.ownKeys(row).some(key => key !== 'kind' && key !== 'afterId') || !Object.hasOwn(row, 'kind') || row.kind !== 'geo_dataset' && row.kind !== 'benchmark_prompt') return fail('INVALID_INPUT')
  if (row.afterId !== undefined && (typeof row.afterId !== 'string' || !/^[1-9]\d{0,9}$/u.test(row.afterId) || Number(row.afterId) > 2_147_483_647)) return fail('INVALID_INPUT')
  return { kind: row.kind, afterId: row.afterId === undefined ? 0 : Number(row.afterId) }
}

/** Invoke inside the owner's read-only transaction; the cursor is an ordering hint, not authority. */
export async function readKnowledgeConsumerCatalog(ownerUserId: number, input: unknown, repository: KnowledgeConsumerBindingRepository): Promise<KnowledgeConsumerCatalog> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || ownerUserId > 2_147_483_647) return fail('INVALID_INPUT')
  const { kind, afterId } = parseKnowledgeConsumerCatalogQuery(input)
  if (!repository.listNativeAnchors) return fail('CORRUPT_STATE')
  const rows = await repository.listNativeAnchors(ownerUserId, kind, afterId, KNOWLEDGE_CONSUMER_CATALOG_PAGE_SIZE + 1)
  if (rows.length > KNOWLEDGE_CONSUMER_CATALOG_PAGE_SIZE + 1) return fail('LIMIT_EXCEEDED')
  let previousId = afterId
  for (const row of rows) {
    assertValidKnowledgeConsumerAnchor(row)
    if (row.ownerUserId !== ownerUserId || row.consumerKind !== kind || row.consumerId <= previousId) return fail('CORRUPT_STATE')
    previousId = row.consumerId
  }
  const visible = rows.slice(0, KNOWLEDGE_CONSUMER_CATALOG_PAGE_SIZE)
  return {
    consumerKind: kind,
    items: visible.map(row => ({ consumerKind: row.consumerKind, consumerId: row.consumerId, consumerVersion: row.consumerVersion, consumerContentHash: row.consumerContentHash })),
    nextAfterId: rows.length > KNOWLEDGE_CONSUMER_CATALOG_PAGE_SIZE ? visible.at(-1)!.consumerId : null,
    scope: 'owner_native_immutable_consumers_v1', rawTextIncluded: false,
    automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false,
  }
}
