import type { VisibilityCompetitorCreate, VisibilityCompetitorUpdate, VisibilityQueryUpdate } from './contracts'
import { VisibilityContractError } from './contracts'
import { canonicalHostname } from './guards'
import { canonicalBrandKey, prepareQuery, type ProjectRecord, type QueryRecord } from './service'
import { MAX_PROJECT_COMPETITOR_TERMS } from '../llm-visibility-probes/normalization'

export const COMPETITOR_TERM_LIMIT_MESSAGE = '此 project 的有效競品名稱與 alias 合計不可超過 30 筆（探測引擎上限）。'

export type PromptVersionRecord = {
  id: number
  ownerUserId: number
  projectId: number
  queryId: number
  versionNumber: number
  promptText: string
  promptHash: string
  createdAt?: Date | string
}

export type CompetitorRecord = {
  id: number
  ownerUserId: number
  projectId: number
  name: string
  canonicalKey: string
  aliases: string[]
  domain: string | null
  active: boolean
  createdAt?: Date | string
  updatedAt?: Date | string
}

export interface VisibilityRegistryRepository {
  transaction<T>(work: (repository: VisibilityRegistryRepository) => Promise<T>): Promise<T>
  getProject(ownerUserId: number, projectId: number): Promise<ProjectRecord | null>
  listProjectQueries(ownerUserId: number, projectId: number): Promise<QueryRecord[]>
  getQuery(ownerUserId: number, queryId: number): Promise<QueryRecord | null>
  findQueryByHash(ownerUserId: number, projectId: number, promptHash: string): Promise<QueryRecord | null>
  updateQuery(ownerUserId: number, queryId: number, values: { promptText?: string, promptHash?: string, active?: boolean, updatedAt: Date }): Promise<QueryRecord>
  getLatestPromptVersion(ownerUserId: number, queryId: number): Promise<PromptVersionRecord | null>
  insertPromptVersion(values: Omit<PromptVersionRecord, 'id' | 'createdAt'>): Promise<PromptVersionRecord>
  listCompetitors(ownerUserId: number, projectId: number, options?: { activeOnly?: boolean, limit?: number }): Promise<CompetitorRecord[]>
  getCompetitor(ownerUserId: number, competitorId: number): Promise<CompetitorRecord | null>
  findCompetitorByKey(ownerUserId: number, projectId: number, canonicalKey: string): Promise<CompetitorRecord | null>
  insertCompetitor(values: Omit<CompetitorRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CompetitorRecord>
  updateCompetitor(ownerUserId: number, competitorId: number, values: Partial<Pick<CompetitorRecord, 'name' | 'canonicalKey' | 'aliases' | 'domain' | 'active'>> & { updatedAt: Date }): Promise<CompetitorRecord>
}

function displayName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

function normalizeAliases(values: string[], excludedKey: string): string[] {
  if (values.length > 20) throw new VisibilityContractError(422, '競品 alias 最多 20 筆。')
  const seen = new Set([excludedKey])
  const aliases: string[] = []
  for (const value of values) {
    const alias = displayName(value)
    if (!alias || alias.length > 160) throw new VisibilityContractError(422, '競品 alias 必須為 1 至 160 字元。')
    const key = canonicalBrandKey(alias)
    if (seen.has(key)) continue
    seen.add(key)
    aliases.push(alias)
  }
  return aliases
}

function assertNoBrandCollision(project: ProjectRecord, name: string, aliases: string[]) {
  const protectedKeys = new Set([project.brandName, ...project.brandAliases].map(canonicalBrandKey))
  const collision = [name, ...aliases].find(value => protectedKeys.has(canonicalBrandKey(value)))
  if (collision) throw new VisibilityContractError(422, `競品名稱或 alias「${collision}」不可與品牌名稱或 alias 相同。`)
}

function prepareCompetitor(project: ProjectRecord, input: VisibilityCompetitorCreate | (VisibilityCompetitorUpdate & { name: string, aliases: string[], domain: string | null })) {
  const name = displayName(input.name)
  if (!name || name.length > 160) throw new VisibilityContractError(422, '競品名稱必須為 1 至 160 字元。')
  const canonicalKey = canonicalBrandKey(name)
  const aliases = normalizeAliases(input.aliases, canonicalKey)
  assertNoBrandCollision(project, name, aliases)
  const domain = input.domain ? canonicalHostname(input.domain) : null
  return { name, canonicalKey, aliases, domain }
}

export function activeCompetitorTerms(competitors: CompetitorRecord[]): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const value of competitors.filter(row => row.active).flatMap(row => [row.name, ...row.aliases])) {
    const key = canonicalBrandKey(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    terms.push(value)
  }
  return terms
}

export function assertActiveCompetitorTermLimit(competitors: CompetitorRecord[]): string[] {
  const terms = activeCompetitorTerms(competitors)
  if (terms.length > MAX_PROJECT_COMPETITOR_TERMS) throw new VisibilityContractError(422, COMPETITOR_TERM_LIMIT_MESSAGE)
  return terms
}

export async function ensurePromptVersion(repository: VisibilityRegistryRepository, queryRow: QueryRecord): Promise<{ version: PromptVersionRecord, created: boolean }> {
  const current = await repository.getLatestPromptVersion(queryRow.ownerUserId, queryRow.id)
  if (current) return { version: current, created: false }
  try {
    const version = await repository.insertPromptVersion({ ownerUserId: queryRow.ownerUserId, projectId: queryRow.projectId, queryId: queryRow.id, versionNumber: 1, promptText: queryRow.promptText, promptHash: queryRow.promptHash })
    return { version, created: true }
  } catch (error: any) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error
    const concurrent = await repository.getLatestPromptVersion(queryRow.ownerUserId, queryRow.id)
    if (!concurrent) throw error
    return { version: concurrent, created: false }
  }
}

export async function updateVisibilityQuery(repository: VisibilityRegistryRepository, ownerUserId: number, queryId: number, input: VisibilityQueryUpdate) {
  return repository.transaction(async transaction => {
    const query = await transaction.getQuery(ownerUserId, queryId)
    if (!query) throw new VisibilityContractError(404, '找不到此 owner 的 tracking query。')
    const current = await ensurePromptVersion(transaction, query)
    const prepared = input.promptText === undefined ? null : prepareQuery({ projectId: query.projectId, promptText: input.promptText, intent: query.intent, locale: query.locale, active: input.active ?? query.active })
    const versionChanged = Boolean(prepared && prepared.promptHash !== current.version.promptHash)
    if (versionChanged) {
      const duplicate = await transaction.findQueryByHash(ownerUserId, query.projectId, prepared!.promptHash)
      if (duplicate && duplicate.id !== query.id) throw new VisibilityContractError(409, '這個 project 已有相同的 tracking prompt。')
    }
    const updated = await transaction.updateQuery(ownerUserId, query.id, {
      ...(versionChanged ? { promptText: prepared!.promptText, promptHash: prepared!.promptHash } : {}),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: new Date(),
    })
    if (!versionChanged) return { query: updated, currentVersion: current.version, versionChanged: false as const }
    try {
      const nextVersion = await transaction.insertPromptVersion({ ownerUserId, projectId: query.projectId, queryId: query.id, versionNumber: current.version.versionNumber + 1, promptText: prepared!.promptText, promptHash: prepared!.promptHash })
      return { query: updated, currentVersion: nextVersion, versionChanged: true as const }
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') throw new VisibilityContractError(409, 'Prompt version 更新衝突，請重新載入後再試。')
      throw error
    }
  })
}

export async function ensureCompetitorRegistry(repository: VisibilityRegistryRepository, projectRow: ProjectRecord): Promise<{ created: number, competitors: CompetitorRecord[] }> {
  const existing = await repository.listCompetitors(projectRow.ownerUserId, projectRow.id)
  const existingKeys = new Set(existing.map(row => row.canonicalKey))
  let created = 0
  for (const legacyName of projectRow.competitorBrands) {
    const prepared = prepareCompetitor(projectRow, { name: legacyName, aliases: [], domain: null })
    if (existingKeys.has(prepared.canonicalKey)) continue
    const candidate = { id: -1, ownerUserId: projectRow.ownerUserId, projectId: projectRow.id, ...prepared, active: true }
    assertActiveCompetitorTermLimit([...existing, candidate])
    const inserted = await repository.insertCompetitor({ ownerUserId: projectRow.ownerUserId, projectId: projectRow.id, ...prepared, active: true })
    existing.push(inserted)
    existingKeys.add(prepared.canonicalKey)
    created += 1
  }
  return { created, competitors: await repository.listCompetitors(projectRow.ownerUserId, projectRow.id) }
}

export async function syncProjectRegistry(repository: VisibilityRegistryRepository, ownerUserId: number, projectId: number) {
  return repository.transaction(async transaction => {
    const project = await transaction.getProject(ownerUserId, projectId)
    if (!project) throw new VisibilityContractError(404, '找不到此 owner 的 LLM visibility project。')
    const queries = await transaction.listProjectQueries(ownerUserId, project.id)
    const promptVersions: Array<{ queryId: number, promptVersionId: number, versionNumber: number }> = []
    let promptVersionsCreated = 0
    for (const query of queries) {
      const ensured = await ensurePromptVersion(transaction, query)
      if (ensured.created) promptVersionsCreated += 1
      promptVersions.push({ queryId: query.id, promptVersionId: ensured.version.id, versionNumber: ensured.version.versionNumber })
    }
    const competitorResult = await ensureCompetitorRegistry(transaction, project)
    return { promptVersionsCreated, competitorsCreated: competitorResult.created, promptVersions, competitors: competitorResult.competitors }
  })
}

export async function listCompetitors(repository: VisibilityRegistryRepository, ownerUserId: number, projectId: number, activeOnly = false) {
  const project = await repository.getProject(ownerUserId, projectId)
  if (!project) throw new VisibilityContractError(404, '找不到此 owner 的 LLM visibility project。')
  return repository.listCompetitors(ownerUserId, projectId, { activeOnly, limit: 500 })
}

export async function createCompetitor(repository: VisibilityRegistryRepository, ownerUserId: number, projectId: number, input: VisibilityCompetitorCreate) {
  return repository.transaction(async transaction => {
    const project = await transaction.getProject(ownerUserId, projectId)
    if (!project) throw new VisibilityContractError(404, '找不到此 owner 的 LLM visibility project。')
    const prepared = prepareCompetitor(project, input)
    if (await transaction.findCompetitorByKey(ownerUserId, project.id, prepared.canonicalKey)) throw new VisibilityContractError(409, '此 project 已有相同的 competitor canonical key。')
    const competitors = await transaction.listCompetitors(ownerUserId, project.id)
    assertActiveCompetitorTermLimit([...competitors, { id: -1, ownerUserId, projectId: project.id, ...prepared, active: true }])
    try { return await transaction.insertCompetitor({ ownerUserId, projectId: project.id, ...prepared, active: true }) } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') throw new VisibilityContractError(409, '此 project 已有相同的 competitor canonical key。')
      throw error
    }
  })
}

export async function updateCompetitor(repository: VisibilityRegistryRepository, ownerUserId: number, competitorId: number, input: VisibilityCompetitorUpdate) {
  return repository.transaction(async transaction => {
    const existing = await transaction.getCompetitor(ownerUserId, competitorId)
    if (!existing) throw new VisibilityContractError(404, '找不到此 owner 的 competitor。')
    const project = await transaction.getProject(ownerUserId, existing.projectId)
    if (!project) throw new VisibilityContractError(404, '找不到此 owner 的 competitor。')
    const prepared = prepareCompetitor(project, { name: input.name ?? existing.name, aliases: input.aliases ?? existing.aliases, domain: input.domain === undefined ? existing.domain : input.domain, active: input.active ?? existing.active })
    const duplicate = await transaction.findCompetitorByKey(ownerUserId, existing.projectId, prepared.canonicalKey)
    if (duplicate && duplicate.id !== existing.id) throw new VisibilityContractError(409, '此 project 已有相同的 competitor canonical key。')
    const active = input.active ?? existing.active
    const competitors = await transaction.listCompetitors(ownerUserId, existing.projectId)
    assertActiveCompetitorTermLimit(competitors.map(row => row.id === existing.id ? { ...row, ...prepared, active } : row))
    try { return await transaction.updateCompetitor(ownerUserId, existing.id, { ...prepared, ...(input.active === undefined ? {} : { active: input.active }), updatedAt: new Date() }) } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') throw new VisibilityContractError(409, '此 project 已有相同的 competitor canonical key。')
      throw error
    }
  })
}

export async function deactivateCompetitor(repository: VisibilityRegistryRepository, ownerUserId: number, competitorId: number) {
  return updateCompetitor(repository, ownerUserId, competitorId, { active: false })
}
