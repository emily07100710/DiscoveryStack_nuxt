import { getTableName, type SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { GeoOutcomeDrizzleDatabase } from '../../server/geo-outcome-model/repository-drizzle'

type Row = Record<string, unknown>
type State = { tables: Record<string, Row[]>, nextIds: Record<string, number> }

const UNIQUE_KEYS: Record<string, string[][]> = {
  geoOutcomeObservationRuns: [['ownerUserId', 'runIdentity'], ['ownerUserId', 'runFingerprint']],
  geoOutcomeObservationCandidates: [['ownerUserId', 'observationFingerprint'], ['ownerUserId', 'observationRunId', 'candidatePageIdentityHash']],
  geoOutcomeDatasetManifests: [['ownerUserId', 'manifestId'], ['ownerUserId', 'manifestFingerprint']],
  geoOutcomeDatasetMembers: [['datasetManifestId', 'observationFingerprint']],
  geoOutcomeDatasetDecisions: [['decisionId']],
  geoOutcomeTrainingRuns: [['ownerUserId', 'trainingRunId']],
  geoOutcomeModelArtifacts: [['ownerUserId', 'artifactId'], ['ownerUserId', 'artifactHash']],
  geoOutcomeModelDecisions: [['decisionId']],
  geoOutcomeIdempotencyClaims: [['ownerUserId', 'routeIdentity', 'idempotencyKey']],
  geoOutcomeObservationVerifications: [['ownerUserId', 'decisionFingerprint']],
  geoOutcomeEvidenceLocators: [['ownerUserId', 'observationFingerprint']],
  geoOutcomeCandidateSetDecisions: [['decisionId'], ['ownerUserId', 'idempotencyKey'], ['ownerUserId', 'sourceObservationId', 'candidateSetFingerprint', 'decisionType']],
  geoOutcomeCandidateAuthorities: [['candidateSetDecisionId', 'canonicalCandidateUrlHash'], ['candidateSetDecisionId', 'candidatePageIdentityHash']],
  llmVisibilityProjects: [],
  llmVisibilityQueries: [['projectId', 'promptHash']],
  llmVisibilityRuns: [['ownerUserId', 'requestFingerprint']],
  llmVisibilityObservations: [['runId', 'queryId']],
  llmVisibilityObservationReviews: [['decisionId'], ['ownerUserId', 'idempotencyKey'], ['observationId', 'newStatus']],
  contentOperationPublicationAttempts: [['ownerUserId', 'idempotencyKey']],
}

function copy<T>(value: T): T { return structuredClone(value) }
function same(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) return new Date(left as string | Date).getTime() === new Date(right as string | Date).getTime()
  return left === right
}
function projectedRow(row: Row, projection: unknown): Row {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return copy(row)
  const output: Row = {}
  for (const [alias, column] of Object.entries(projection as Record<string, { name?: string }>)) {
    if (!column || typeof column.name !== 'string') throw new Error('Strict harness rejected an invalid projection.')
    output[alias] = copy(row[column.name])
  }
  return output
}

class SelectBuilder implements PromiseLike<Row[]> {
  private condition: SQL | undefined
  private maximum: number | undefined
  constructor(private readonly harness: StrictGeoDrizzleHarness, private readonly tableName: string, private readonly projection: unknown) {}
  where(condition: SQL): this { this.condition = condition; return this }
  orderBy(..._columns: unknown[]): this { return this }
  limit(maximum: number): this { this.maximum = maximum; return this }
  then<TResult1 = Row[], TResult2 = never>(onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this.harness.selectRows(this.tableName, this.projection, this.condition, this.maximum).then(onfulfilled, onrejected)
  }
}

export class StrictGeoDrizzleHarness {
  private state: State
  private readonly dialect = new MySqlDialect()
  private readonly transactionContext = new AsyncLocalStorage<boolean>()
  private transactionLock: Promise<void> = Promise.resolve()

  constructor(initial?: State) {
    this.state = initial ? copy(initial) : { tables: {}, nextIds: {} }
  }
  asDatabase(): GeoOutcomeDrizzleDatabase { return this as unknown as GeoOutcomeDrizzleDatabase }
  exportState(): State { return copy(this.state) }
  corrupt(tableName: string, predicate: (row: Row) => boolean, patch: Row): void {
    const row = (this.state.tables[tableName] || []).find(predicate)
    if (!row) throw new Error('Strict harness corruption target was not found.')
    Object.assign(row, copy(patch))
  }
  count(tableName: string): number { return (this.state.tables[tableName] || []).length }

  select(projection?: unknown) {
    return { from: (table: object) => new SelectBuilder(this, getTableName(table as never), projection) }
  }
  insert(table: object) {
    const tableName = getTableName(table as never)
    return { values: async (value: Row) => this.insertRow(tableName, value) }
  }
  update(table: object) {
    const tableName = getTableName(table as never)
    return { set: (patch: Row) => ({ where: async (condition: SQL) => this.updateRows(tableName, patch, condition) }) }
  }
  async transaction<T>(work: (transaction: GeoOutcomeDrizzleDatabase) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work(this.asDatabase())
    const previous = this.transactionLock
    let release!: () => void
    this.transactionLock = new Promise<void>(resolve => { release = resolve })
    await previous
    const snapshot = copy(this.state)
    try { return await this.transactionContext.run(true, () => work(this.asDatabase())) } catch (error) { this.state = snapshot; throw error } finally { release() }
  }

  async selectRows(tableName: string, projection: unknown, condition?: SQL, maximum?: number): Promise<Row[]> {
    const predicate = condition ? this.predicate(condition) : () => true
    const rows = (this.state.tables[tableName] || []).filter(predicate)
    return (maximum === undefined ? rows : rows.slice(0, maximum)).map(row => projectedRow(row, projection))
  }
  private predicate(condition: SQL): (row: Row) => boolean {
    const query = this.dialect.sqlToQuery(condition)
    const columns = [...query.sql.matchAll(/`[^`]+`\.`([^`]+)` = \?/gu)].map(match => match[1]!)
    if (columns.length !== query.params.length) throw new Error(`Strict harness rejected unsupported WHERE SQL: ${query.sql}`)
    return row => columns.every((column, index) => same(row[column], query.params[index]))
  }
  private validateForeignKeys(tableName: string, row: Row): void {
    const has = (target: string, id: unknown) => (this.state.tables[target] || []).some(item => item.id === id)
    if (tableName === 'geoOutcomeObservationCandidates' && !has('geoOutcomeObservationRuns', row.observationRunId)) throw new Error('Strict harness foreign key violation: observation run.')
    if ((tableName === 'geoOutcomeDatasetMembers' || tableName === 'geoOutcomeTrainingRuns') && !has('geoOutcomeDatasetManifests', row.datasetManifestId)) throw new Error('Strict harness foreign key violation: dataset manifest.')
    if (tableName === 'geoOutcomeDatasetDecisions' && !has('geoOutcomeDatasetManifests', row.datasetManifestId)) throw new Error('Strict harness foreign key violation: dataset decision manifest.')
    if (tableName === 'geoOutcomeModelDecisions' && !has('geoOutcomeModelArtifacts', row.modelArtifactId)) throw new Error('Strict harness foreign key violation: model artifact.')
    if ((tableName === 'geoOutcomeObservationVerifications' || tableName === 'geoOutcomeEvidenceLocators') && !(this.state.tables.geoOutcomeObservationCandidates || []).some(item => item.ownerUserId === row.ownerUserId && item.observationFingerprint === row.observationFingerprint)) throw new Error('Strict harness foreign key violation: observation fingerprint.')
    if (tableName === 'geoOutcomeEvidenceLocators' && !has('llmVisibilityObservations', row.sourceRecordId)) throw new Error('Strict harness foreign key violation: authoritative evidence source.')
    if (tableName === 'geoOutcomeEvidenceLocators' && !has('geoOutcomeCandidateAuthorities', row.candidateAuthorityId)) throw new Error('Strict harness foreign key violation: candidate authority.')
    if (tableName === 'geoOutcomeCandidateSetDecisions' && (!has('llmVisibilityObservations', row.sourceObservationId) || !has('llmVisibilityProjects', row.sourceProjectId) || !has('llmVisibilityQueries', row.sourceQueryId) || !has('llmVisibilityRuns', row.sourceRunId))) throw new Error('Strict harness foreign key violation: candidate set source provenance.')
    if (tableName === 'geoOutcomeCandidateAuthorities' && (!has('geoOutcomeCandidateSetDecisions', row.candidateSetDecisionId) || !has('llmVisibilityObservations', row.sourceObservationId) || !has('llmVisibilityProjects', row.projectId) || !has('llmVisibilityQueries', row.queryId) || !has('llmVisibilityRuns', row.runId))) throw new Error('Strict harness foreign key violation: candidate authority provenance.')
    if (tableName === 'llmVisibilityQueries' && !has('llmVisibilityProjects', row.projectId)) throw new Error('Strict harness foreign key violation: LLM visibility query project.')
    if (tableName === 'llmVisibilityRuns' && !has('llmVisibilityProjects', row.projectId)) throw new Error('Strict harness foreign key violation: LLM visibility run project.')
    if (tableName === 'llmVisibilityObservations' && (!has('llmVisibilityProjects', row.projectId) || !has('llmVisibilityQueries', row.queryId) || !has('llmVisibilityRuns', row.runId))) throw new Error('Strict harness foreign key violation: LLM visibility observation provenance.')
    if (tableName === 'llmVisibilityObservationReviews' && !has('llmVisibilityObservations', row.observationId)) throw new Error('Strict harness foreign key violation: LLM visibility review observation.')
  }
  private async insertRow(tableName: string, value: Row) {
    const rows = this.state.tables[tableName] || (this.state.tables[tableName] = [])
    const row = copy(value)
    for (const keys of UNIQUE_KEYS[tableName] || []) if (rows.some(existing => keys.every(key => same(existing[key], row[key])))) throw new Error(`Strict harness unique constraint: ${tableName}(${keys.join(',')}).`)
    this.validateForeignKeys(tableName, row)
    const id = this.state.nextIds[tableName] || 1
    this.state.nextIds[tableName] = id + 1
    row.id = id
    if (row.createdAt === undefined) row.createdAt = new Date()
    rows.push(row)
    return [{ insertId: id, affectedRows: 1 }]
  }
  private async updateRows(tableName: string, patch: Row, condition: SQL) {
    const rows = this.state.tables[tableName] || []
    const predicate = this.predicate(condition)
    let count = 0
    for (const row of rows) {
      if (!predicate(row)) continue
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'version' && value && typeof value === 'object') row.version = Number(row.version) + 1
        else row[key] = copy(value)
      }
      count += 1
    }
    return [{ affectedRows: count }]
  }
}
