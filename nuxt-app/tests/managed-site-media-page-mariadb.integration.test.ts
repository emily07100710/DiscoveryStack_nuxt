import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../server/database/schema'
import { makeDrizzleMediaVaultRepository } from '../server/managed-sites/media-vault/repository-drizzle'
import { createInitialPage } from '../server/managed-sites/page-editor/canonical'
import { makeDrizzlePageEditorRepository } from '../server/managed-sites/page-editor/repository-drizzle'

const enabled = process.env.DS_RUN_MANAGED_EDITOR_DB_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const suite = enabled ? describe : describe.skip
let connection: mysql.Connection
const migrationDirectory = new URL('../server/database/migrations', import.meta.url).pathname

function sha(value: number) { return value.toString(16).padStart(64, '0').slice(-64) }
function tableNodes(value: unknown, output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) { for (const item of value) tableNodes(item, output); return output }
  if (!value || typeof value !== 'object') return output
  const record = value as Record<string, unknown>
  if (typeof record.table_name === 'string') output.push(record)
  for (const item of Object.values(record)) tableNodes(item, output)
  return output
}
function pageDocument(index: number) {
  const route = index === 0 ? '/' : `/page-${String(index).padStart(4, '0')}`
  return createInitialPage({ ownerUserId: 1, projectId: 10, actorUserId: 1, authority: 'system_test', role: 'platform_owner', canPublish: true }, {
    pageId: `page-${String(index).padStart(4, '0')}`,
    locale: 'zh-hant',
    route,
    contentType: index === 0 ? 'home' : 'standard',
    designThemeId: 'integration',
    designTokenVersion: 'tokens-v1',
    designTokens: { palette: 'indigo_sand', typeScale: 'balanced', spacing: 'balanced', radius: 'soft', maxWidth: 'standard', contrast: 'aa' },
    sections: [{ blockId: `block-${String(index).padStart(4, '0')}`, type: 'rich_text', visible: true, layoutVariant: 'prose', data: { nodes: [{ type: 'paragraph', text: `Body ${index}` }] }, mediaBindingIds: [], schedule: null }],
    seo: { title: `Page ${index}`, description: `Integration page ${index} description.`, canonicalPath: route, noindex: false, ogBindingId: null },
    mediaBindings: [],
  }, new Date('2030-01-01T00:00:00.000Z'))
}

suite('Managed media and page repository disposable MariaDB integration', () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl)
    if (parsed.pathname !== '/discoverystack_managed_editor_test') throw new Error('Dedicated disposable managed-editor database is required.')
    connection = await mysql.createConnection(databaseUrl)
    const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES')
    if (tables.length) throw new Error('Disposable managed-editor database must start empty.')
    await migrate(drizzle(databaseUrl), { migrationsFolder: migrationDirectory })
    await connection.query("INSERT INTO users (id,openId,role) VALUES (1,'managed-editor-owner-1','admin'),(2,'managed-editor-owner-2','admin')")
    await connection.query("INSERT INTO managedSiteProjects (id,ownerUserId,canonicalClientIdentity,canonicalWebsiteIdentity,status,siteType,catalogVersion,projectFingerprint,creationIdempotencyKey) VALUES (10,1,'client-10','https://site-10.example.dev','active','brand_blog','catalog-v1',?, 'project-10'),(20,2,'client-20','https://site-20.example.dev','active','brand_blog','catalog-v1',?, 'project-20')", [sha(10), sha(20)])
    await connection.query("INSERT INTO managedSiteStorageConnections (id,ownerUserId,projectId,providerKey,configuration,configurationFingerprint,status) VALUES (101,1,10,'memory_test','{}',?,'mock'),(102,2,20,'memory_test','{}',?,'mock')", [sha(101), sha(102)])

    const now = new Date('2030-01-01T00:00:00.000Z')
    for (let start = 0; start < 10_000; start += 500) {
      const assets: unknown[][] = []; const versions: unknown[][] = []; const objects: unknown[][] = []
      for (let offset = start; offset < start + 500; offset++) {
        const id = offset + 1; const assetId = `asset-${String(id).padStart(5, '0')}`
        assets.push([id, assetId, 1, 10, 'public', `${assetId}.png`, 'image', 'ready', 1, id, 1, 'system_test', '{"license":"owned","publishAllowed":true,"source":null,"photographer":null,"consentReference":null,"expiresAt":null}', now, now])
        versions.push([id, 1, 10, assetId, 1, 'image/png', 'image/png', 128, 10, 10, sha(id), sha(id + 20_000), '{"scannerVerdict":"passed"}', now])
        objects.push([id, 1, 10, id, 101, `tenant/1/project/10/assets/${assetId}/v1/original.png`, 'original', 128, sha(id), now])
      }
      await connection.query('INSERT INTO managedSiteMediaAssets (id,assetId,ownerUserId,projectId,visibility,originalFilename,mediaType,status,currentVersion,currentVersionId,createdByUserId,createdByAuthority,rightsMetadata,createdAt,updatedAt) VALUES ?', [assets])
      await connection.query('INSERT INTO managedSiteMediaAssetVersions (id,ownerUserId,projectId,assetId,version,declaredMime,sniffedMime,byteSize,width,height,sha256,processingFingerprint,metadata,createdAt) VALUES ?', [versions])
      await connection.query('INSERT INTO managedSiteMediaObjects (id,ownerUserId,projectId,assetVersionId,connectionId,objectKey,objectKind,byteSize,sha256,createdAt) VALUES ?', [objects])
    }
    const pages = []; const pageVersions = []
    for (let index = 0; index < 1_000; index++) {
      const document = pageDocument(index); const id = index + 1
      pages.push([id, document.pageId, 1, 10, document.locale, document.route, document.contentType, 1, 0, 'draft', now, now])
      pageVersions.push([id, 1, 10, document.pageId, 1, JSON.stringify(document), document.fingerprint, 'draft', 'system_test', now])
    }
    for (let start = 0; start < pages.length; start += 250) {
      await connection.query('INSERT INTO managedSitePages (id,pageId,ownerUserId,projectId,locale,route,contentType,currentDraftVersion,publishedVersion,status,createdAt,updatedAt) VALUES ?', [pages.slice(start, start + 250)])
      await connection.query('INSERT INTO managedSitePageVersions (id,ownerUserId,projectId,pageId,version,document,documentFingerprint,lifecycleStatus,actorAuthority,createdAt) VALUES ?', [pageVersions.slice(start, start + 250)])
    }
    // A later rejected replacement is intentionally present. It must never become the current original authority.
    await connection.query("INSERT INTO managedSiteMediaAssetVersions (id,ownerUserId,projectId,assetId,version,declaredMime,sniffedMime,byteSize,width,height,sha256,processingFingerprint,metadata,createdAt) VALUES (10001,1,10,'asset-00001',2,'image/png','image/png',256,20,20,?,?, '{\"scannerVerdict\":\"blocked\"}',?)", [sha(30_001), sha(40_001), new Date('2030-01-02T00:00:00.000Z')])
    await connection.query("INSERT INTO managedSiteMediaObjects (id,ownerUserId,projectId,assetVersionId,connectionId,objectKey,objectKind,byteSize,sha256,createdAt) VALUES (10001,1,10,10001,101,'tenant/1/project/10/assets/asset-00001/v2/rejected.png','original',256,?,?)", [sha(30_001), new Date('2030-01-02T00:00:00.000Z')])
    await connection.query("INSERT INTO managedSiteMediaUploadSessions (uploadId,ownerUserId,projectId,assetId,connectionId,objectKey,originalFilename,visibility,declaredMime,declaredBytes,idempotencyKey,requestFingerprint,status,expiresAt,createdAt) VALUES ('upload-rejected-0001',1,10,'asset-00001',101,'tenant/1/project/10/assets/asset-00001/v2/rejected.png','rejected.png','public','image/png',256,'upload-rejected-idempotency',?,'rejected',?,?)", [sha(50_001), new Date('2030-01-02T01:00:00.000Z'), new Date('2030-01-02T00:00:00.000Z')])
  }, 90_000)

  afterAll(async () => { await connection?.end() })

  it('keeps current-version original immutable and blocks owner/project IDOR', async () => {
    const repository = makeDrizzleMediaVaultRepository(drizzle(databaseUrl, { schema, mode: 'default' }))
    const asset = await repository.findAsset({ ownerUserId: 1, projectId: 10 }, 'asset-00001')
    expect(asset).toMatchObject({ version: 1, originalObjectKey: 'tenant/1/project/10/assets/asset-00001/v1/original.png', sha256: sha(1) })
    await expect(repository.findAsset({ ownerUserId: 2, projectId: 20 }, 'asset-00001')).resolves.toBeNull()
    const first = await repository.listAssets({ ownerUserId: 1, projectId: 10 }, { limit: 100 })
    expect(first).toHaveLength(100)
    expect(first.every(item => item.ownerUserId === 1 && item.projectId === 10)).toBe(true)
    const next = await repository.listAssets({ ownerUserId: 1, projectId: 10 }, { limit: 100, beforeCreatedAt: first.at(-1)!.createdAt, beforeAssetId: first.at(-1)!.assetId })
    expect(new Set([...first, ...next].map(item => item.assetId)).size).toBe(200)
  })

  it('permits exactly one concurrent asset state claim', async () => {
    const repository = makeDrizzleMediaVaultRepository(drizzle(databaseUrl, { schema, mode: 'default' }))
    const claims = await Promise.all([
      repository.claimAssetStatus({ ownerUserId: 1, projectId: 10 }, 'asset-00002', ['ready'], 'trashed'),
      repository.claimAssetStatus({ ownerUserId: 1, projectId: 10 }, 'asset-00002', ['ready'], 'trashed'),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('uses bounded keyset indexes for 10k assets and 1k pages', async () => {
    const [assetRows] = await connection.query<mysql.RowDataPacket[]>(`EXPLAIN FORMAT=JSON
      SELECT a.id,a.assetId,a.currentVersionId,v.version,o.objectKey
        FROM managedSiteMediaAssets a
        JOIN managedSiteMediaAssetVersions v ON v.id=a.currentVersionId AND v.ownerUserId=? AND v.projectId=?
        LEFT JOIN managedSiteMediaObjects o ON o.assetVersionId=v.id AND o.ownerUserId=? AND o.projectId=? AND o.objectKind='original' AND o.deletedAt IS NULL
       WHERE a.ownerUserId=? AND a.projectId=? AND a.deletedAt IS NULL AND a.status<>'deleted'
         AND (a.createdAt<? OR (a.createdAt=? AND a.assetId<?))
       ORDER BY a.createdAt DESC,a.assetId DESC LIMIT 100`, [1, 10, 1, 10, 1, 10, new Date('2030-01-02T00:00:00.000Z'), new Date('2030-01-02T00:00:00.000Z'), 'asset-99999'])
    const assetNodes = tableNodes(JSON.parse(String(assetRows[0]?.EXPLAIN)))
    const assetNode = assetNodes.find(node => node.table_name === 'a')
    expect(assetNode).toBeTruthy(); expect(assetNode?.access_type).not.toBe('ALL'); expect(assetNode?.key).toBe('managed_site_media_asset_tenant_page_idx')

    const [pageRows] = await connection.query<mysql.RowDataPacket[]>(`EXPLAIN FORMAT=JSON
      SELECT p.pageId,p.route,v.document
        FROM managedSitePages p
        JOIN managedSitePageVersions v ON v.ownerUserId=? AND v.projectId=? AND v.pageId=p.pageId AND v.version=p.currentDraftVersion
       WHERE p.ownerUserId=? AND p.projectId=? AND (p.route>? OR (p.route=? AND p.pageId>?))
       ORDER BY p.route,p.pageId LIMIT 100`, [1, 10, 1, 10, '/page-0499', '/page-0499', 'page-0499'])
    const pageNodes = tableNodes(JSON.parse(String(pageRows[0]?.EXPLAIN)))
    const pageNode = pageNodes.find(node => node.table_name === 'p')
    expect(pageNode).toBeTruthy(); expect(pageNode?.access_type).not.toBe('ALL'); expect(pageNode?.key).toBe('managed_site_page_tenant_route_idx')

    const pages = await makeDrizzlePageEditorRepository(drizzle(databaseUrl, { schema, mode: 'default' })).listPages(1, 10, { limit: 100, afterRoute: '/page-0499', afterPageId: 'page-0499' })
    expect(pages).toHaveLength(100); expect(pages[0]!.route > '/page-0499').toBe(true)
  })
})
