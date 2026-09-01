import { and, count, desc, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { requireAuditDatabase } from '../audit/repository'
import { siteEvidenceFindings, siteEvidenceScans, siteEvidenceSitemaps, siteEvidenceSnapshots, siteEvidenceUrls } from '../database/schema'
import type { DiscoverySource, InventoryUpsert, ScanCreate, ScanPatch, SiteEvidenceFinding, SiteEvidenceRepository, SiteEvidenceScan, SiteEvidenceSitemap, SiteEvidenceSnapshot, SiteEvidenceUrl } from './types'

export function requireSiteEvidenceDatabase() {
  try { return requireAuditDatabase() } catch {
    throw createError({ statusCode: 503, statusMessage: 'Site evidence database is temporarily unavailable.' })
  }
}

function scanRow(row: typeof siteEvidenceScans.$inferSelect): SiteEvidenceScan {
  return { ...row, limitations: Array.isArray(row.limitations) ? row.limitations.filter((value): value is string => typeof value === 'string') : null }
}

function urlRow(row: typeof siteEvidenceUrls.$inferSelect): SiteEvidenceUrl {
  return {
    ...row,
    discoverySources: Array.isArray(row.discoverySources) ? row.discoverySources.filter((value): value is DiscoverySource => value === 'sitemap' || value === 'crawl' || value === 'seed') : [],
    redirectChain: Array.isArray(row.redirectChain) ? row.redirectChain as SiteEvidenceUrl['redirectChain'] : null,
  }
}

export function createSiteEvidenceRepository(): SiteEvidenceRepository {
  return {
    async findScanByIdempotencyKey(ownerUserId, idempotencyKey) {
      const database = requireSiteEvidenceDatabase()
      const [row] = await database.select().from(siteEvidenceScans).where(and(eq(siteEvidenceScans.ownerUserId, ownerUserId), eq(siteEvidenceScans.idempotencyKey, idempotencyKey))).limit(1)
      return row ? scanRow(row) : null
    },
    async createScan(input: ScanCreate) {
      const database = requireSiteEvidenceDatabase()
      const result = await database.insert(siteEvidenceScans).values(input)
      const id = Number(result[0].insertId)
      const [row] = await database.select().from(siteEvidenceScans).where(and(eq(siteEvidenceScans.id, id), eq(siteEvidenceScans.ownerUserId, input.ownerUserId))).limit(1)
      if (!row) throw createError({ statusCode: 503, statusMessage: 'Site evidence scan could not be created.' })
      return scanRow(row)
    },
    async getScanForOwner(scanId, ownerUserId) {
      const database = requireSiteEvidenceDatabase()
      const [row] = await database.select().from(siteEvidenceScans).where(and(eq(siteEvidenceScans.id, scanId), eq(siteEvidenceScans.ownerUserId, ownerUserId))).limit(1)
      return row ? scanRow(row) : null
    },
    async getScan(scanId) {
      const database = requireSiteEvidenceDatabase()
      const [row] = await database.select().from(siteEvidenceScans).where(eq(siteEvidenceScans.id, scanId)).limit(1)
      return row ? scanRow(row) : null
    },
    async updateScan(scanId, patch: ScanPatch) {
      const database = requireSiteEvidenceDatabase()
      const [scan] = await database.select({ ownerUserId: siteEvidenceScans.ownerUserId }).from(siteEvidenceScans).where(eq(siteEvidenceScans.id, scanId)).limit(1)
      if (!scan) return
      await database.update(siteEvidenceScans).set(patch).where(and(eq(siteEvidenceScans.id, scanId), eq(siteEvidenceScans.ownerUserId, scan.ownerUserId)))
    },
    async listScansForOwner(ownerUserId, limit) {
      const database = requireSiteEvidenceDatabase()
      const rows = await database.select().from(siteEvidenceScans).where(eq(siteEvidenceScans.ownerUserId, ownerUserId)).orderBy(desc(siteEvidenceScans.createdAt), desc(siteEvidenceScans.id)).limit(limit)
      return rows.map(scanRow)
    },
    async upsertUrl(input: InventoryUpsert) {
      const database = requireSiteEvidenceDatabase()
      const [existing] = await database.select().from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.ownerUserId, input.ownerUserId), eq(siteEvidenceUrls.urlHash, input.urlHash))).limit(1)
      if (existing) {
        const discoverySources = [...new Set([...urlRow(existing).discoverySources, ...input.discoverySources])]
        await database.update(siteEvidenceUrls).set({ ...input, discoverySources, firstSeenAt: existing.firstSeenAt }).where(and(eq(siteEvidenceUrls.id, existing.id), eq(siteEvidenceUrls.ownerUserId, input.ownerUserId)))
        const [updated] = await database.select().from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.id, existing.id), eq(siteEvidenceUrls.ownerUserId, input.ownerUserId))).limit(1)
        if (!updated) throw createError({ statusCode: 503, statusMessage: 'Site evidence URL could not be updated.' })
        return urlRow(updated)
      }
      try {
        const result = await database.insert(siteEvidenceUrls).values(input)
        const id = Number(result[0].insertId)
        const [created] = await database.select().from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.id, id), eq(siteEvidenceUrls.ownerUserId, input.ownerUserId))).limit(1)
        if (!created) throw new Error('missing_insert')
        return urlRow(created)
      } catch (error) {
        const candidate = error as { code?: string, errno?: number }
        if (candidate.code !== 'ER_DUP_ENTRY' && candidate.errno !== 1062) throw error
        const [raced] = await database.select().from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.ownerUserId, input.ownerUserId), eq(siteEvidenceUrls.urlHash, input.urlHash))).limit(1)
        if (!raced) throw error
        const discoverySources = [...new Set([...urlRow(raced).discoverySources, ...input.discoverySources])]
        await database.update(siteEvidenceUrls).set({ ...input, discoverySources, firstSeenAt: raced.firstSeenAt }).where(and(eq(siteEvidenceUrls.id, raced.id), eq(siteEvidenceUrls.ownerUserId, input.ownerUserId)))
        return { ...urlRow(raced), ...input, discoverySources, id: raced.id, firstSeenAt: raced.firstSeenAt }
      }
    },
    async insertSnapshot(input: SiteEvidenceSnapshot) {
      const database = requireSiteEvidenceDatabase()
      await database.insert(siteEvidenceSnapshots).values(input)
    },
    async insertSitemap(input: SiteEvidenceSitemap) {
      const database = requireSiteEvidenceDatabase()
      const { entries: _entries, ...row } = input
      await database.insert(siteEvidenceSitemaps).values(row)
    },
    async insertFindings(input) {
      if (!input.length) return
      const database = requireSiteEvidenceDatabase()
      await database.insert(siteEvidenceFindings).values(input)
    },
    async listUrlsForScan(scanId, ownerUserId, limit, offset) {
      const database = requireSiteEvidenceDatabase()
      const rows = await database.select().from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.lastScanId, scanId), eq(siteEvidenceUrls.ownerUserId, ownerUserId))).orderBy(siteEvidenceUrls.normalizedUrl).limit(limit).offset(offset)
      return rows.map(urlRow)
    },
    async listFindingsForScan(scanId, ownerUserId) {
      const database = requireSiteEvidenceDatabase()
      return database.select().from(siteEvidenceFindings).where(and(eq(siteEvidenceFindings.scanId, scanId), eq(siteEvidenceFindings.ownerUserId, ownerUserId))).orderBy(siteEvidenceFindings.category, siteEvidenceFindings.id) as Promise<SiteEvidenceFinding[]>
    },
    async countUrlsForScan(scanId, ownerUserId) {
      const database = requireSiteEvidenceDatabase()
      const [row] = await database.select({ total: count() }).from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.lastScanId, scanId), eq(siteEvidenceUrls.ownerUserId, ownerUserId)))
      return Number(row?.total || 0)
    },
    async countFindingsForScan(scanId, ownerUserId) {
      const database = requireSiteEvidenceDatabase()
      const [row] = await database.select({ total: count() }).from(siteEvidenceFindings).where(and(eq(siteEvidenceFindings.scanId, scanId), eq(siteEvidenceFindings.ownerUserId, ownerUserId)))
      return Number(row?.total || 0)
    },
  }
}
