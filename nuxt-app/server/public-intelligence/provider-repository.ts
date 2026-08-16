import { and, eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { providerCredentials } from '../database/schema'
import { decryptProviderSecret, encryptProviderSecret, redactProviderSecret, runtimeProviderMasterSecret } from '../utils/provider-vault'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Provider settings are temporarily unavailable.' })
  return database
}

async function findOwnerCredentials(ownerUserId: number) {
  const database = requireDatabase()
  const [row] = await database.select().from(providerCredentials).where(eq(providerCredentials.ownerUserId, ownerUserId)).limit(1)
  return row || null
}

export async function getOwnerProviderCredentials(ownerUserId: number) {
  const row = await findOwnerCredentials(ownerUserId)
  if (!row) return { firecrawlApiKey: null, huggingFaceApiToken: null, huggingFaceNamespace: null, createdAt: null, updatedAt: null }
  const masterSecret = runtimeProviderMasterSecret()
  return {
    firecrawlApiKey: decryptProviderSecret(row.firecrawlApiKeyCiphertext, masterSecret),
    huggingFaceApiToken: decryptProviderSecret(row.huggingFaceApiTokenCiphertext, masterSecret),
    huggingFaceNamespace: row.huggingFaceNamespace,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function saveOwnerProviderCredentials(input: { ownerUserId: number, firecrawlApiKey?: string, huggingFaceApiToken?: string, huggingFaceNamespace?: string }) {
  const database = requireDatabase()
  const existing = await findOwnerCredentials(input.ownerUserId)
  const masterSecret = runtimeProviderMasterSecret()
  const values = {
    ownerUserId: input.ownerUserId,
    firecrawlApiKeyCiphertext: input.firecrawlApiKey?.trim() ? encryptProviderSecret(input.firecrawlApiKey.trim(), masterSecret) : existing?.firecrawlApiKeyCiphertext || null,
    huggingFaceApiTokenCiphertext: input.huggingFaceApiToken?.trim() ? encryptProviderSecret(input.huggingFaceApiToken.trim(), masterSecret) : existing?.huggingFaceApiTokenCiphertext || null,
    huggingFaceNamespace: input.huggingFaceNamespace?.trim() || existing?.huggingFaceNamespace || null,
  }
  if (existing) {
    await database.update(providerCredentials).set(values).where(and(eq(providerCredentials.id, existing.id), eq(providerCredentials.ownerUserId, input.ownerUserId)))
    return { id: existing.id }
  }
  const result = await database.insert(providerCredentials).values(values)
  return { id: Number(result[0].insertId) }
}

export async function getOwnerProviderStatus(ownerUserId: number) {
  const credentials = await getOwnerProviderCredentials(ownerUserId)
  const runtime = useRuntimeConfig()
  const firecrawlApiKey = credentials.firecrawlApiKey || String(runtime.firecrawlApiKey || '')
  const huggingFaceApiToken = credentials.huggingFaceApiToken || String(runtime.huggingFaceApiToken || '')
  return {
    firecrawl: { ...redactProviderSecret(firecrawlApiKey), source: credentials.firecrawlApiKey ? 'owner_settings' as const : firecrawlApiKey ? 'server_runtime' as const : 'missing' as const },
    huggingface: { ...redactProviderSecret(huggingFaceApiToken), source: credentials.huggingFaceApiToken ? 'owner_settings' as const : huggingFaceApiToken ? 'server_runtime' as const : 'missing' as const, namespace: credentials.huggingFaceNamespace || String(runtime.huggingFaceNamespace || ''), baseModelId: String(runtime.huggingFaceBaseModelId || 'distilbert/distilbert-base-multilingual-cased') },
    updatedAt: credentials.updatedAt,
  }
}
