import { getTableName, sql, type SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { geoOutcomeObservationCandidates, geoOutcomeObservationRuns } from '../../server/database/schema'
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
function projectedRow(row: Row, projection: unknown, mainTableName: string, joinedRow?: Row | null, joinedTableName?: string): Row {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return copy(row)
  const output: Row = {}
  for (const [alias, column] of Object.entries(projection as Record<string, { name?: string }>)) {
    if (column && typeof column === 'object' && !('name' in column)) {
      try {
        const tableName = getTableName(column as never)
        if (tableName === mainTableName) { output[alias] = copy(row); continue }
        if (tableName === joinedTableName) { output[alias] = joinedRow ? copy(joinedRow) : null; continue }
      } catch { /* not a table projection */ }
    }
    if (!column || typeof column.name !== 'string') throw new Error('Strict harness rejected an invalid projection.')
    output[alias] = copy(row[column.name])
  }
  return output
}

class SelectBuilder implements PromiseLike<Row[]> {
  private condition: SQL | undefined
  private maximum: number | undefined
  private join: { tableName: string, condition: SQL } | undefined
  constructor(private readonly harness: StrictGeoDrizzleHarness, private readonly tableName: string, private readonly projection: unknown) {}
  where(condition: SQL): this { this.condition = condition; return this }
  orderBy(..._columns: unknown[]): this { return this }
  leftJoin(table: object, condition: SQL): this { this.join = { tableName: getTableName(table as never), condition }; return this }
  limit(maximum: number): this { this.maximum = maximum; return this }
  for(lock: 'update'): this {
    if (lock !== 'update') throw new Error('Strict harness rejected an unsupported row lock.')
    this.harness.assertUpdateLockContext()
    return this
  }
  then<TResult1 = Row[], TResult2 = never>(onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this.harness.selectRows(this.tableName, this.projection, this.condition, this.maximum, this.join).then(onfulfilled, onrejected)
  }
}

class InsertBuilder implements PromiseLike<Array<{ insertId: number, affectedRows: number }>> {
  private input: Row | undefined
  private noOpOnDuplicate = false
  constructor(private readonly harness: StrictGeoDrizzleHarness, private readonly tableName: string) {}
  values(value: Row): this { this.input = value; return this }
  onDuplicateKeyUpdate(input: { set: Row }): this {
    this.harness.assertExactObservationRunNoOp(this.tableName, input.set)
    this.noOpOnDuplicate = true
    return this
  }
  then<TResult1 = Array<{ insertId: number, affectedRows: number }>, TResult2 = never>(onfulfilled?: ((value: Array<{ insertId: number, affectedRows: number }>) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    if (!this.input) return Promise.reject(new Error('Strict harness rejected insert without values.')).then(onfulfilled, onrejected)
    return this.harness.insertRow(this.tableName, this.input, this.noOpOnDuplicate).then(onfulfilled, onrejected)
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

  assertUpdateLockContext(): void {
    // The strict harness models lock serialization with its transaction-wide mutex, not a row-level/MySQL lock.
    if (!this.transactionContext.getStore()) throw new Error('Strict harness FOR UPDATE requires an active harness transaction.')
  }
  assertExactObservationRunNoOp(tableName: string, patch: Row): void {
    const column = tableName === 'geoOutcomeObservationRuns'
      ? geoOutcomeObservationRuns.id
      : tableName === 'geoOutcomeObservationCandidates'
        ? geoOutcomeObservationCandidates.id
        : null
    if (!column || Object.keys(patch).length !== 1 || !patch.id || typeof patch.id !== 'object') throw new Error('Strict harness only supports exact observation run/candidate id=id duplicate no-ops.')
    try {
      const actual = this.dialect.sqlToQuery(patch.id as SQL)
      const expected = this.dialect.sqlToQuery(sql`${column}`)
      if (actual.sql !== expected.sql || actual.params.length !== 0) throw new Error('mismatch')
    } catch {
      throw new Error('Strict harness only supports exact observation run/candidate id=id duplicate no-ops.')
    }
  }

  select(projection?: unknown) {
    return { from: (table: object) => new SelectBuilder(this, getTableName(table as never), projection) }
  }
  insert(table: object) {
    return new InsertBuilder(this, getTableName(table as never))
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

  async selectRows(tableName: string, projection: unknown, condition?: SQL, maximum?: number, join?: { tableName: string, condition: SQL }): Promise<Row[]> {
    const predicate = condition ? this.predicate(condition) : () => true
    const rows = (this.state.tables[tableName] || []).filter(predicate)
    const bounded = maximum === undefined ? rows : rows.slice(0, maximum)
    if (!join) return bounded.map(row => projectedRow(row, projection, tableName))
    const joinQuery = this.dialect.sqlToQuery(join.condition)
    let joinParamIndex = 0
    const equalities = [...joinQuery.sql.matchAll(/`([^`]+)`\.`([^`]+)` = (?:`([^`]+)`\.`([^`]+)`|\?)/gu)].map(match => ({ leftTable: match[1]!, leftColumn: match[2]!, rightTable: match[3] ?? null, rightColumn: match[4] ?? null, expected: match[3] ? undefined : joinQuery.params[joinParamIndex++] }))
    if (!equalities.length) throw new Error(`Strict harness rejected unsupported JOIN SQL: ${joinQuery.sql}`)
    if (joinParamIndex !== joinQuery.params.length) throw new Error(`Strict harness rejected unsupported JOIN parameters: ${joinQuery.sql}`)
    const joined = this.state.tables[join.tableName] || []
    return bounded.map(row => {
      const match = joined.find(candidate => equalities.every(item => {
        const left = item.leftTable === tableName ? row[item.leftColumn] : item.leftTable === join.tableName ? candidate[item.leftColumn] : undefined
        if (!item.rightTable) return same(left, item.expected)
        const right = item.rightTable === tableName ? row[item.rightColumn!] : item.rightTable === join.tableName ? candidate[item.rightColumn!] : undefined
        return same(left, right)
      })) || null
      return projectedRow(row, projection, tableName, match, join.tableName)
    })
  }
  private predicate(condition: SQL): (row: Row) => boolean {
    const query = this.dialect.sqlToQuery(condition)
    const checks: Array<(row: Row) => boolean> = []
    let paramIndex = 0
    const placeholders = [...query.sql.matchAll(/`[^`]+`\.`([^`]+)` = \?/gu)]
    for (const match of placeholders) {
      const column = match[1]!
      const expected = query.params[paramIndex++]
      checks.push(row => same(row[column], expected))
    }
    for (const match of query.sql.matchAll(/`[^`]+`\.`([^`]+)` in \(([^)]+)\)/giu)) {
      const column = match[1]!
      const count = (match[2]!.match(/\?/gu) || []).length
      const expected = query.params.slice(paramIndex, paramIndex + count)
      paramIndex += count
      checks.push(row => expected.some(item => same(row[column], item)))
    }
    if (!checks.length || paramIndex !== query.params.length) throw new Error(`Strict harness rejected unsupported WHERE SQL: ${query.sql}`)
    return row => checks.every(check => check(row))
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
  async insertRow(tableName: string, value: Row, noOpOnDuplicate = false) {
    const rows = this.state.tables[tableName] || (this.state.tables[tableName] = [])
    const row = copy(value)
    if (noOpOnDuplicate) this.validateForeignKeys(tableName, row)
    const duplicates = (UNIQUE_KEYS[tableName] || []).flatMap(keys => {
      const matching = rows.find(existing => keys.every(key => same(existing[key], row[key])))
      return matching ? [{ keys, row: matching }] : []
    })
    if (duplicates.length) {
      if (!noOpOnDuplicate || !['geoOutcomeObservationRuns', 'geoOutcomeObservationCandidates'].includes(tableName) || duplicates.some(item => item.row !== duplicates[0]!.row)) {
        throw new Error(`Strict harness unique constraint: ${tableName}(${duplicates[0]!.keys.join(',')}).`)
      }
      return [{ insertId: Number(duplicates[0]!.row.id), affectedRows: 0 }]
    }
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
