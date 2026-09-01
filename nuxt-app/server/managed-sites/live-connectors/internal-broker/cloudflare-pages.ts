import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { ManagedSiteStaticAsset } from './static-renderer'

const API_ORIGIN = 'https://api.cloudflare.com'
const MAX_RESPONSE_BYTES = 256 * 1024

type CloudflareEnvelope = { success?: boolean; result?: unknown; errors?: unknown }
export type CloudflarePagesOptions = { fetchImpl: typeof fetch; accountId: string; apiToken: string; projectPrefix: string; now?: () => number; sleep?: (milliseconds: number) => Promise<void> }

function cloudflareError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status, code: status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'UPSTREAM_FAILURE' : 'PROVIDER_REJECTED', retryable: status === 429 || status >= 500 })
}

async function boundedJson(response: Response): Promise<CloudflareEnvelope> {
  const announced = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) throw cloudflareError(502, 'Cloudflare response exceeded the fixed limit.')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw cloudflareError(502, 'Cloudflare response exceeded the fixed limit.')
  let value: unknown
  try { value = raw ? JSON.parse(raw) : {} } catch { throw cloudflareError(502, 'Cloudflare returned malformed JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw cloudflareError(502, 'Cloudflare returned malformed JSON.')
  return value as CloudflareEnvelope
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs = 8_000): Promise<{ response: Response; envelope: CloudflareEnvelope }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(timeoutMs, 8_000)))
  let response: Response
  try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal }) } catch { throw cloudflareError(503, controller.signal.aborted ? 'Cloudflare request timed out.' : 'Cloudflare transport failed.') } finally { clearTimeout(timer) }
  const envelope = await boundedJson(response)
  return { response, envelope }
}

function resultObject(envelope: CloudflareEnvelope): Record<string, any> {
  if (envelope.success !== true || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw cloudflareError(502, 'Cloudflare response did not contain a successful result.')
  return envelope.result as Record<string, any>
}

function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }

export async function verifyCloudflarePagesAccess(options: Pick<CloudflarePagesOptions, 'fetchImpl' | 'accountId' | 'apiToken'>): Promise<void> {
  const url = `${API_ORIGIN}/client/v4/accounts/${options.accountId}/pages/projects?per_page=1`
  const { response, envelope } = await request(options.fetchImpl, url, { method: 'GET', headers: bearer(options.apiToken) })
  if (response.status !== 200 || envelope.success !== true) throw cloudflareError(response.status >= 400 ? response.status : 502, 'Cloudflare Pages capability probe was rejected.')
}

export function managedSitePagesProjectName(prefix: string, ownerUserId: number, projectId: number): string {
  const name = `${prefix}-o${ownerUserId}-p${projectId}`
  if (name.length > 58 || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw cloudflareError(422, 'Cloudflare Pages project identity is invalid.')
  return name
}

export function cloudflarePagesAssetHash(asset: ManagedSiteStaticAsset): string {
  const extension = asset.path.includes('.') ? asset.path.slice(asset.path.lastIndexOf('.') + 1).toLowerCase() : ''
  const base64 = Buffer.from(asset.content, 'utf8').toString('base64')
  return bytesToHex(blake3(new TextEncoder().encode(`${base64}${extension}`))).slice(0, 32)
}

async function ensureProject(options: CloudflarePagesOptions, projectName: string): Promise<void> {
  const base = `${API_ORIGIN}/client/v4/accounts/${options.accountId}/pages/projects`
  const headers = bearer(options.apiToken)
  const current = await request(options.fetchImpl, `${base}/${projectName}`, { method: 'GET', headers })
  if (current.response.status === 200 && current.envelope.success === true) return
  if (current.response.status !== 404) throw cloudflareError(current.response.status, 'Cloudflare Pages project lookup failed.')
  const created = await request(options.fetchImpl, base, { method: 'POST', headers, body: JSON.stringify({ name: projectName, production_branch: 'main' }) })
  if ((created.response.status === 200 || created.response.status === 201) && created.envelope.success === true) return
  if (created.response.status === 409) return
  throw cloudflareError(created.response.status, 'Cloudflare Pages project creation failed.')
}

function deploymentReady(value: Record<string, any>): boolean {
  const stage = value.latest_stage
  return Boolean(stage && typeof stage === 'object' && stage.name === 'deploy' && stage.status === 'success')
}

function deploymentUrl(value: Record<string, any>, projectName: string): string {
  const candidate = typeof value.url === 'string' ? value.url : Array.isArray(value.aliases) ? value.aliases.find(item => typeof item === 'string' && item.includes('.pages.dev')) : ''
  let url: URL
  try { url = new URL(candidate) } catch { throw cloudflareError(502, 'Cloudflare deployment did not return a preview URL.') }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.pages.dev') || url.username || url.password) throw cloudflareError(502, 'Cloudflare deployment preview URL was invalid.')
  if (!url.hostname.includes(projectName)) throw cloudflareError(502, 'Cloudflare deployment preview URL did not match the project.')
  return url.toString()
}

export async function deployCloudflarePagesPreview(input: { ownerUserId: number; projectId: number; releaseId: number; assets: ManagedSiteStaticAsset[]; timeoutMs: number }, options: CloudflarePagesOptions): Promise<{ deploymentId: string; deploymentUrl: string; projectName: string }> {
  const now = options.now || Date.now; const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = now() + Math.max(2_000, Math.min(input.timeoutMs - 3_000, 24_000))
  const projectName = managedSitePagesProjectName(options.projectPrefix, input.ownerUserId, input.projectId)
  await ensureProject(options, projectName)
  const accountProject = `${API_ORIGIN}/client/v4/accounts/${options.accountId}/pages/projects/${projectName}`
  const tokenResponse = await request(options.fetchImpl, `${accountProject}/upload-token`, { method: 'POST', headers: bearer(options.apiToken), body: '{}' })
  if (!tokenResponse.response.ok) throw cloudflareError(tokenResponse.response.status, 'Cloudflare Pages upload token request failed.')
  const tokenResult = resultObject(tokenResponse.envelope)
  const uploadToken = typeof tokenResult.jwt === 'string' ? tokenResult.jwt : typeof tokenResult.token === 'string' ? tokenResult.token : ''
  if (uploadToken.length < 16) throw cloudflareError(502, 'Cloudflare Pages upload token was incomplete.')
  const hashed = input.assets.map(asset => ({ asset, hash: cloudflarePagesAssetHash(asset), base64: Buffer.from(asset.content, 'utf8').toString('base64') }))
  const check = await request(options.fetchImpl, `${API_ORIGIN}/pages/assets/check-missing`, { method: 'POST', headers: bearer(uploadToken), body: JSON.stringify({ hashes: hashed.map(item => item.hash) }) })
  if (!check.response.ok) throw cloudflareError(check.response.status, 'Cloudflare Pages missing-assets check failed.')
  const missingResult = check.envelope.result
  const missing = new Set(Array.isArray(missingResult) ? missingResult.filter(item => typeof item === 'string') : typeof missingResult === 'object' && missingResult && Array.isArray((missingResult as any).missing) ? (missingResult as any).missing.filter((item: unknown) => typeof item === 'string') : [])
  const uploads = hashed.filter(item => missing.has(item.hash))
  for (let index = 0; index < uploads.length; index += 50) {
    const batch = uploads.slice(index, index + 50).map(item => ({ key: item.hash, value: item.base64, metadata: { contentType: item.asset.contentType }, base64: true }))
    const uploaded = await request(options.fetchImpl, `${API_ORIGIN}/pages/assets/upload`, { method: 'POST', headers: bearer(uploadToken), body: JSON.stringify(batch) })
    if (!uploaded.response.ok || uploaded.envelope.success === false) throw cloudflareError(uploaded.response.status, 'Cloudflare Pages asset upload failed.')
  }
  const form = new FormData()
  form.set('manifest', JSON.stringify(Object.fromEntries(hashed.map(item => [`/${item.asset.path}`, item.hash]))))
  form.set('branch', `preview-r${input.releaseId}`)
  const created = await request(options.fetchImpl, `${accountProject}/deployments`, { method: 'POST', headers: { authorization: `Bearer ${options.apiToken}` }, body: form }, Math.max(500, deadline - now()))
  if (!created.response.ok) throw cloudflareError(created.response.status, 'Cloudflare Pages deployment creation failed.')
  let deployment = resultObject(created.envelope)
  const deploymentId = typeof deployment.id === 'string' ? deployment.id : ''
  if (!/^[A-Za-z0-9._:-]{3,160}$/u.test(deploymentId)) throw cloudflareError(502, 'Cloudflare Pages deployment identity was incomplete.')
  let polls = 0
  while (!deploymentReady(deployment)) {
    if (now() >= deadline || polls++ >= 40) throw cloudflareError(503, 'Cloudflare Pages preview deployment did not become ready within the bounded budget.')
    await sleep(Math.min(750, Math.max(0, deadline - now())))
    const polled = await request(options.fetchImpl, `${accountProject}/deployments/${deploymentId}`, { method: 'GET', headers: bearer(options.apiToken) }, Math.max(500, deadline - now()))
    if (!polled.response.ok) throw cloudflareError(polled.response.status, 'Cloudflare Pages deployment poll failed.')
    deployment = resultObject(polled.envelope)
  }
  return { deploymentId, deploymentUrl: deploymentUrl(deployment, projectName), projectName }
}
