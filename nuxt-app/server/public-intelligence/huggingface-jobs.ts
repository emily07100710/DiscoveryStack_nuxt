import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { HF_TRAINING_SCRIPT } from './hf-training-script'
import { getOwnerProviderCredentials } from './provider-repository'

export type HuggingFaceJob = {
  id: string
  url?: string
  status?: { stage?: string, message?: string }
  owner?: { name?: string }
  [key: string]: unknown
}

type TrainingRecord = { id: number, label: string, targets: Record<string, string | string[]>, split: 'train' | 'validation' | 'test', featureVector: unknown }

async function config(ownerUserId?: number) {
  const runtime = useRuntimeConfig()
  const stored = ownerUserId ? await getOwnerProviderCredentials(ownerUserId) : null
  return {
    token: stored?.huggingFaceApiToken || String(runtime.huggingFaceApiToken || ''),
    namespace: stored?.huggingFaceNamespace || String(runtime.huggingFaceNamespace || ''),
    baseModelId: String(runtime.huggingFaceBaseModelId || 'distilbert/distilbert-base-multilingual-cased'),
    flavor: String(runtime.huggingFaceJobFlavor || 'a10g-small'),
  }
}

export async function isHuggingFaceConfigured(ownerUserId?: number) {
  return Boolean((await config(ownerUserId)).token)
}

function safeHash(value: string) { return createHash('sha256').update(value).digest('hex') }

function providerError(statusCode: number, code: string, detail?: string): never {
  throw createError({ statusCode, statusMessage: detail ? `${code}: ${detail}` : code, data: { provider: 'huggingface_jobs', code } })
}

async function request(path: string, init: RequestInit = {}, ownerUserId?: number) {
  const { token } = await config(ownerUserId)
  if (!token) providerError(503, 'huggingface_not_configured', 'Set HUGGINGFACE_API_TOKEN in the server environment.')
  const response = await fetch(`https://huggingface.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body: unknown = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text.slice(0, 500) } }
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body ? String(body.error) : `HTTP ${response.status}`
    providerError(response.status >= 400 && response.status < 500 ? 422 : 503, 'huggingface_request_failed', detail)
  }
  return body
}

async function resolveNamespace(ownerUserId?: number) {
  const configured = (await config(ownerUserId)).namespace.trim()
  if (configured) return configured
  const identity = await request('/api/whoami-v2', {}, ownerUserId) as { name?: string, preferredUsername?: string }
  const namespace = String(identity.name || identity.preferredUsername || '').trim()
  if (!namespace) providerError(422, 'huggingface_namespace_missing', 'Set HUGGINGFACE_NAMESPACE or give the token an identifiable user namespace.')
  return namespace
}

function recordText(record: TrainingRecord) {
  return JSON.stringify(record.featureVector)
}

export function trainingDatasetDigest(records: TrainingRecord[]) {
  return safeHash(records.map(record => `${record.id}:${record.label}:${JSON.stringify(record.targets)}:${record.split}:${recordText(record)}`).join('\n'))
}

export async function startHuggingFaceTraining(input: { ownerUserId?: number, runId: number, mode: 'development' | 'production', records: TrainingRecord[] }) {
  const { token, baseModelId, flavor } = await config(input.ownerUserId)
  if (!token) providerError(503, 'huggingface_not_configured', 'Set HUGGINGFACE_API_TOKEN in the server environment.')
  const namespace = await resolveNamespace(input.ownerUserId)
  const modelRepo = `${namespace}/discoverystack-seo-geo-${input.runId}`
  const dataset = input.records.map(record => JSON.stringify({ text: recordText(record), label: record.label, targets: record.targets, split: record.split })).join('\n')
  const datasetB64 = Buffer.from(dataset, 'utf8').toString('base64')
  const response = await request(`/api/jobs/${encodeURIComponent(namespace)}`, {
    method: 'POST',
    body: JSON.stringify({
      dockerImage: 'python:3.11-slim',
      command: ['bash', '-lc', HF_TRAINING_SCRIPT],
      secrets: {
        HF_TOKEN: token,
        DISCOVERYSTACK_DATASET_B64: datasetB64,
      },
      environment: {
        HUGGINGFACE_BASE_MODEL_ID: baseModelId,
        HUGGINGFACE_MODEL_REPO: modelRepo,
        DISCOVERYSTACK_EPOCHS: input.mode === 'production' ? '3' : '1',
      },
      flavor,
      timeoutSeconds: input.mode === 'production' ? 14_400 : 7_200,
      labels: { application: 'discoverystack', feature: 'seo-geo-multitask-training', run: String(input.runId) },
      attempts: 1,
    }),
  }, input.ownerUserId) as HuggingFaceJob
  const jobId = String(response.id || '')
  if (!jobId) providerError(503, 'huggingface_missing_job_id')
  return { namespace, jobId, jobUrl: String(response.url || `https://huggingface.co/jobs/${namespace}/${jobId}`), modelRepo, baseModelId, datasetDigest: trainingDatasetDigest(input.records), flavor }
}

export async function getHuggingFaceJob(namespace: string, jobId: string, ownerUserId?: number) {
  return request(`/api/jobs/${encodeURIComponent(namespace)}/${encodeURIComponent(jobId)}`, {}, ownerUserId) as Promise<HuggingFaceJob>
}

export async function getHuggingFaceJobLogs(namespace: string, jobId: string, ownerUserId?: number) {
  const { token } = await config(ownerUserId)
  if (!token) providerError(503, 'huggingface_not_configured')
  const response = await fetch(`https://huggingface.co/api/jobs/${encodeURIComponent(namespace)}/${encodeURIComponent(jobId)}/logs?tail=500`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/plain' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return ''
  return response.text()
}

export function parseTrainingResult(logs: string) {
  const marker = logs.split('\n').find(line => line.startsWith('DISCOVERYSTACK_RESULT='))
  if (!marker) return null
  try { return JSON.parse(marker.slice('DISCOVERYSTACK_RESULT='.length)) as Record<string, unknown> } catch { return null }
}
