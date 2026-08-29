import { getMediaStorageConnection } from '../../../../managed-sites/media-vault/repository-drizzle'
import { createLocalDevMediaStorage, verifyLocalMediaRead } from '../../../../managed-sites/media-vault/storage'
import { requireEditorActor } from '../../../../managed-sites/page-editor/http'
export default defineEventHandler(async event => {
  const { mediaActor } = await requireEditorActor(event, 'content:read'); const query = getQuery(event); const objectKey = typeof query.key === 'string' ? query.key : ''; const expires = Number(query.expires); const signature = typeof query.signature === 'string' ? query.signature : ''
  const connection = await getMediaStorageConnection(mediaActor); const configuration = connection.configuration as Record<string, unknown>; if (connection.providerKey !== 'local_dev' || process.env.NODE_ENV === 'production' || typeof configuration.root !== 'string') throw createError({ statusCode: 404, statusMessage: 'Local media delivery is unavailable.' })
  verifyLocalMediaRead({ root: configuration.root, scope: mediaActor, objectKey, expires, signature }); const bytes = await createLocalDevMediaStorage(configuration.root).readForProcessing({ ...mediaActor, objectKey, maxBytes: 52_428_800 }); const extension = objectKey.split('.').at(-1)
  setHeader(event, 'Content-Type', extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'avif' ? 'image/avif' : 'image/jpeg'); setHeader(event, 'Content-Length', bytes.byteLength); setHeader(event, 'Content-Disposition', 'inline'); return bytes
})
