import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { and, eq } from 'drizzle-orm'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../server/database/schema'
import { buildCitationSelectionDataset } from '../server/geo-outcome-model/dataset-builder'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import { DrizzleKnowledgeConsumerBindingRepository } from '../server/knowledge/consumer-bindings-drizzle'
import { mutateKnowledgeConsumerBinding, readKnowledgeConsumerBindingWorkspace } from '../server/knowledge/consumer-bindings'
import type { KnowledgeConsumerBindingInput, KnowledgeConsumerBindingRepository } from '../server/knowledge/consumer-binding-types'
import { DrizzleKnowledgeRepository } from '../server/knowledge/repository-drizzle'
import { createKnowledgeService } from '../server/knowledge/service'
import { createKnowledgeImpactPreview } from '../server/knowledge/impact-preview'
import { readKnowledgeConsumerCatalog } from '../server/knowledge/consumer-catalog'
import { getKnowledgeRevisionHistory } from '../server/knowledge/revision-history'
import { assertValidKnowledgeMutationEvent, assertValidKnowledgeRevision, knowledgeRevisionSha256 } from '../server/knowledge/revision-records'
import { KnowledgeRevisionError, type KnowledgeRevisionSubject } from '../server/knowledge/revision-types'
import type { KnowledgeRepository } from '../server/knowledge/types'
import { generateUlid } from '../server/knowledge/ulid'
import { prepareProject, prepareQuery } from '../server/llm-visibility/service'
import { createDrizzleVisibilityRegistryRepository } from '../server/llm-visibility/repository'
import { ensurePromptVersion } from '../server/llm-visibility/registry'

const enabled = process.env.DS_RUN_KNOWLEDGE_MYSQL_INTEGRATION === '1'
const socketPath = process.env.DS_KNOWLEDGE_MYSQL_SOCKET ?? ''
const databaseName = process.env.DS_KNOWLEDGE_MYSQL_DATABASE ?? ''
const permittedSocket = /^\/private\/tmp\/ds-knowledge-mysql-[A-Za-z0-9]+\/mysql\.sock$/u
const permittedDatabase = 'ds_knowledge_revision_test'
const NOW = new Date('2026-10-08T12:00:00.123Z')
const HASH = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const sentinelExcerpt = 'SYNTHETIC_PRIVATE_EXCERPT_47f3'
const sentinelLocator = 'SYNTHETIC_PRIVATE_LOCATOR_38b2'

let pool: mysql.Pool | undefined
type FixtureDatabase = MySql2Database<typeof schema>
let database: FixtureDatabase | undefined
let owners: [number, number]

function requireDatabase(): FixtureDatabase {
  if (!database) throw new Error('The isolated Knowledge MySQL rehearsal database is not available.')
  return database
}

function service(ownerUserId: number, repository: KnowledgeRepository = new DrizzleKnowledgeRepository(requireDatabase())) {
  return createKnowledgeService({ ownerUserId, repository, now: () => new Date(NOW), entityUid: generateUlid })
}

async function requireOk<T>(result: { status: 'ok'; value: T } | { status: 'rejected'; code: string; reason: string }): Promise<T> {
  if (result.status !== 'ok') throw new Error(`Synthetic Knowledge service operation rejected: ${result.code}`)
  return result.value
}

async function countRows(table: 'knowledgeEntities' | 'knowledgeSubjectRevisions' | 'knowledgeMutationEvents', ownerUserId: number): Promise<number> {
  const rows = await requireDatabase().select({ id: schema[table].id }).from(schema[table]).where(eq(schema[table].ownerUserId, ownerUserId))
  return rows.length
}

async function countBindingRows(table: 'knowledgeConsumerBindings' | 'knowledgeConsumerBindingHeads', ownerUserId: number): Promise<number> {
  const rows = await requireDatabase().select({ id: schema[table].id }).from(schema[table]).where(eq(schema[table].ownerUserId, ownerUserId))
  return rows.length
}

type NativeBindingFixture = {
  ownerUserId: number
  subject: KnowledgeRevisionSubject
  revisionFingerprint: string
  datasetId: number
  datasetFingerprint: string
  promptVersionId: number
  promptVersionNumber: number
  promptHash: string
  promptText: string
}

async function createNativeBindingFixture(ownerUserId: number): Promise<NativeBindingFixture> {
  const knowledge = service(ownerUserId)
  const entity = (await requireOk(await knowledge.createEntity({ entityType: 'Organization', canonicalName: `Synthetic consumer binding subject ${randomUUID()}` }))).entity
  const subject = { kind: 'entity', id: entity.id } as const
  const revision = await new DrizzleKnowledgeRepository(requireDatabase()).getRevisionHead(ownerUserId, subject)
  if (!revision) throw new Error('Synthetic binding subject did not receive its native revision.')

  const dataset = buildCitationSelectionDataset([], ownerUserId)
  const persistedDataset = await new DrizzleGeoOutcomeRepository(requireDatabase()).saveDatasetTransactional(ownerUserId, dataset.manifest, dataset.members)
  const [datasetRow] = await requireDatabase().select({ id: schema.geoOutcomeDatasetManifests.id }).from(schema.geoOutcomeDatasetManifests).where(and(
    eq(schema.geoOutcomeDatasetManifests.ownerUserId, ownerUserId),
    eq(schema.geoOutcomeDatasetManifests.manifestId, persistedDataset.manifestId),
  )).limit(1)
  if (!datasetRow) throw new Error('Synthetic builder-produced dataset manifest was not persisted.')

  const projectInput = prepareProject({
    name: `Synthetic visibility project ${randomUUID()}`,
    canonicalWebsiteUrl: 'https://binding-fixture.example.com',
    locale: 'en',
    brandName: 'Binding Fixture Brand',
    brandAliases: [],
    competitorBrands: [],
  })
  const [projectInsert] = await requireDatabase().insert(schema.llmVisibilityProjects).values({ ...projectInput, ownerUserId, status: 'active' }).$returningId()
  if (!projectInsert) throw new Error('Synthetic canonical visibility project was not persisted.')
  const promptText = '  Will   ALPHA ＆ beta   appear in the answer?  '
  const queryInput = prepareQuery({ projectId: projectInsert.id, promptText, intent: 'synthetic binding integration', locale: 'en', active: true })
  const [queryInsert] = await requireDatabase().insert(schema.llmVisibilityQueries).values({ ...queryInput, ownerUserId }).$returningId()
  if (!queryInsert) throw new Error('Synthetic canonical visibility query was not persisted.')
  const [query] = await requireDatabase().select().from(schema.llmVisibilityQueries).where(and(
    eq(schema.llmVisibilityQueries.ownerUserId, ownerUserId),
    eq(schema.llmVisibilityQueries.id, queryInsert.id),
    eq(schema.llmVisibilityQueries.projectId, projectInsert.id),
  )).limit(1)
  if (!query) throw new Error('Synthetic canonical visibility query could not be reloaded.')
  const ensuredPrompt = await ensurePromptVersion(createDrizzleVisibilityRegistryRepository(requireDatabase()), query)
  return {
    ownerUserId,
    subject,
    revisionFingerprint: revision.revisionFingerprint,
    datasetId: datasetRow.id,
    datasetFingerprint: persistedDataset.manifestFingerprint,
    promptVersionId: ensuredPrompt.version.id,
    promptVersionNumber: ensuredPrompt.version.versionNumber,
    promptHash: ensuredPrompt.version.promptHash,
    promptText: ensuredPrompt.version.promptText,
  }
}

function bindingInput(fixture: NativeBindingFixture, consumerKind: KnowledgeConsumerBindingInput['consumerKind'], consumerId: number, operation: KnowledgeConsumerBindingInput['operation'], expectedBindingFingerprint: string | null, idempotencyKey: string): KnowledgeConsumerBindingInput {
  return {
    consumerKind,
    consumerId,
    subjectKind: fixture.subject.kind,
    subjectId: fixture.subject.id,
    operation,
    expectedRevisionFingerprint: operation === 'bind' ? fixture.revisionFingerprint : null,
    expectedBindingFingerprint,
    idempotencyKey,
  }
}

function failingAfterBindingAppend(database: FixtureDatabase): KnowledgeConsumerBindingRepository {
  const original = new DrizzleKnowledgeConsumerBindingRepository(database)
  return new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(work: (repository: KnowledgeConsumerBindingRepository) => Promise<T>) => target.transaction(transaction => work(new Proxy(transaction, {
          get(inner, key, innerReceiver) {
            if (key === 'appendBinding') return async (record: Parameters<KnowledgeConsumerBindingRepository['appendBinding']>[0]) => {
              await inner.appendBinding(record)
              throw new Error('SYNTHETIC_BINDING_POST_APPEND_ABORT')
            }
            const value: unknown = Reflect.get(inner, key, innerReceiver)
            return typeof value === 'function' ? value.bind(inner) : value
          },
        }) as KnowledgeConsumerBindingRepository))
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as KnowledgeConsumerBindingRepository
}

function failureRepository(): KnowledgeRepository {
  const original = new DrizzleKnowledgeRepository(requireDatabase())
  return new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(work: (repository: KnowledgeRepository) => Promise<T>, options?: Parameters<KnowledgeRepository['transaction']>[1]) => target.transaction(
          transaction => work(new Proxy(transaction, {
            get(inner, key, innerReceiver) {
              if (key === 'appendMutationEvent') return async () => { throw new KnowledgeRevisionError('REVISION_CONFLICT') }
              const value: unknown = Reflect.get(inner, key, innerReceiver)
              return typeof value === 'function' ? value.bind(inner) : value
            },
          }) as KnowledgeRepository),
          options,
        )
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as KnowledgeRepository
}

const suite = enabled ? describe : describe.skip

suite('Knowledge revision persistence against an isolated local MySQL socket', () => {
  beforeAll(async () => {
    if (!permittedSocket.test(socketPath) || databaseName !== permittedDatabase) throw new Error('Only the named private Knowledge test socket and fixed isolated database are permitted.')
    pool = mysql.createPool({ socketPath, user: 'root', database: permittedDatabase, charset: 'utf8mb4', timezone: 'Z', connectionLimit: 8, waitForConnections: true })
    const [before] = await pool.query<mysql.RowDataPacket[]>('SHOW TABLES')
    if (before.length !== 0) throw new Error('Knowledge MySQL integration requires the explicitly provisioned database to contain zero tables.')
    database = drizzle(pool, { schema, mode: 'default' })
    await migrate(database, { migrationsFolder: new URL('../server/database/migrations', import.meta.url).pathname })
    const [migrationRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `__drizzle_migrations`')
    const journal = JSON.parse(readFileSync(new URL('../server/database/migrations/meta/_journal.json', import.meta.url), 'utf8')) as { entries: unknown[] }
    if (Number(migrationRows[0]?.count) !== journal.entries.length) throw new Error('The full official migration chain was not applied to the isolated fixture database.')
    const [customerRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `leads`')
    if (Number(customerRows[0]?.count) !== 0) throw new Error('The migrated isolated database unexpectedly contains customer leads.')
    const [existingOwners] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `users`')
    if (Number(existingOwners[0]?.count) !== 0) throw new Error('The migrated isolated database unexpectedly contains existing owner rows.')
    const [first] = await pool.execute<mysql.ResultSetHeader>('INSERT INTO `users` (`openId`, `role`) VALUES (?, ?)', [`synthetic-knowledge-owner-a-${randomUUID()}`, 'admin'])
    const [second] = await pool.execute<mysql.ResultSetHeader>('INSERT INTO `users` (`openId`, `role`) VALUES (?, ?)', [`synthetic-knowledge-owner-b-${randomUUID()}`, 'admin'])
    owners = [Number(first.insertId), Number(second.insertId)]
  }, 120_000)

  afterAll(async () => {
    if (!pool) return
    try {
      const [leadRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `leads`')
      expect(Number(leadRows[0]?.count)).toBe(0)
    } finally {
      await pool.end()
    }
  })

  it('applies migrations 0051-0053 on the full chain with empty ledgers, pointer keys and owner foreign keys', async () => {
    const [tables] = await pool!.query<mysql.RowDataPacket[]>("SELECT `TABLE_NAME` AS `name` FROM `information_schema`.`TABLES` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` IN ('knowledgeSubjectRevisions','knowledgeMutationEvents','knowledgeConsumerBindings','knowledgeConsumerBindingHeads') ORDER BY `TABLE_NAME`")
    expect(tables.map(row => row.name)).toEqual(['knowledgeConsumerBindingHeads', 'knowledgeConsumerBindings', 'knowledgeMutationEvents', 'knowledgeSubjectRevisions'])
    const [revisions] = await pool!.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `knowledgeSubjectRevisions`')
    const [events] = await pool!.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `knowledgeMutationEvents`')
    const [bindings] = await pool!.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `knowledgeConsumerBindings`')
    const [heads] = await pool!.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `count` FROM `knowledgeConsumerBindingHeads`')
    expect(Number(revisions[0]?.count)).toBe(0)
    expect(Number(events[0]?.count)).toBe(0)
    expect(Number(bindings[0]?.count)).toBe(0)
    expect(Number(heads[0]?.count)).toBe(0)
    const [unique] = await pool!.query<mysql.RowDataPacket[]>("SELECT `TABLE_NAME` AS `tableName`, `INDEX_NAME` AS `indexName`, GROUP_CONCAT(`COLUMN_NAME` ORDER BY `SEQ_IN_INDEX`) AS `columns` FROM `information_schema`.`STATISTICS` WHERE `TABLE_SCHEMA` = DATABASE() AND `NON_UNIQUE` = 0 AND `TABLE_NAME` IN ('knowledgeSubjectRevisions','knowledgeMutationEvents','knowledgeConsumerBindings','knowledgeConsumerBindingHeads') GROUP BY `TABLE_NAME`,`INDEX_NAME`")
    expect(unique).toEqual(expect.arrayContaining([
      expect.objectContaining({ tableName: 'knowledgeSubjectRevisions', indexName: 'ksr_subject_version_uq', columns: 'ownerUserId,subjectKind,subjectId,revisionNumber' }),
      expect.objectContaining({ tableName: 'knowledgeMutationEvents', indexName: 'kme_revision_uq', columns: 'revisionId' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindings', indexName: 'kcb_sequence_uq', columns: 'ownerUserId,consumerKind,consumerId,subjectKind,subjectId,sequenceNumber' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindings', indexName: 'kcb_command_hash_uq', columns: 'ownerUserId,idempotencyKeyHash' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindings', indexName: 'kcb_fingerprint_uq', columns: 'ownerUserId,bindingFingerprint' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindingHeads', indexName: 'kcbh_identity_uq', columns: 'ownerUserId,consumerKind,consumerId,subjectKind,subjectId' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindingHeads', indexName: 'kcbh_binding_uq', columns: 'bindingId' }),
    ]))
    const [foreignKeys] = await pool!.query<mysql.RowDataPacket[]>("SELECT `TABLE_NAME` AS `tableName`, `CONSTRAINT_NAME` AS `constraintName`, `REFERENCED_TABLE_NAME` AS `target` FROM `information_schema`.`KEY_COLUMN_USAGE` WHERE `CONSTRAINT_SCHEMA` = DATABASE() AND `CONSTRAINT_NAME` IN ('ksr_owner_fk','kme_owner_fk','kme_revision_fk','kcb_owner_fk','kcb_revision_fk','kcbh_owner_fk','kcbh_binding_fk') ORDER BY `CONSTRAINT_NAME`")
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ tableName: 'knowledgeSubjectRevisions', constraintName: 'ksr_owner_fk', target: 'users' }),
      expect.objectContaining({ tableName: 'knowledgeMutationEvents', constraintName: 'kme_owner_fk', target: 'users' }),
      expect.objectContaining({ tableName: 'knowledgeMutationEvents', constraintName: 'kme_revision_fk', target: 'knowledgeSubjectRevisions' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindings', constraintName: 'kcb_owner_fk', target: 'users' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindings', constraintName: 'kcb_revision_fk', target: 'knowledgeSubjectRevisions' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindingHeads', constraintName: 'kcbh_owner_fk', target: 'users' }),
      expect.objectContaining({ tableName: 'knowledgeConsumerBindingHeads', constraintName: 'kcbh_binding_fk', target: 'knowledgeConsumerBindings' }),
    ]))
    const journal = JSON.parse(readFileSync(new URL('../server/database/migrations/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string }> }
    expect(journal.entries).toHaveLength(54)
    expect(journal.entries.slice(-3).map(entry => entry.tag)).toEqual([
      '0051_knowledge_subject_revisions_v1',
      '0052_knowledge_consumer_bindings_v1',
      '0053_knowledge_consumer_binding_heads_v1',
    ])
  })

  it('persists the full entity/source/claim lifecycle with paired hashes, immutable events and private history projection', async () => {
    const owner = owners[0]
    const app = service(owner)
    const entity = await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic Persistence Entity' }))
    const createdEntity = entity.entity
    await requireOk(await app.addAlias({ entityId: createdEntity.id, alias: 'Synthetic Persistence Alias' }))
    const source = await requireOk(await app.registerSource({ canonicalUrl: 'https://integration.invalid/source', title: 'Synthetic source', sourceClass: 'government' }))
    const version = await requireOk(await app.addSourceVersion({ sourceId: source.id, contentHash: HASH('synthetic-source-version'), retrievedAt: NOW, excerpt: sentinelExcerpt, metadata: { fixture: true } }))
    const claim = await requireOk(await app.createClaim({ statement: 'Synthetic evidence-backed claim.', claimType: 'research findings', entityIds: [createdEntity.id] }))
    await requireOk(await app.addEvidence({ claimId: claim.id, sourceVersionId: version.id, relation: 'supports', locator: sentinelLocator, contentHash: version.contentHash }))
    await requireOk(await app.transitionClaim({ claimId: claim.id, toStatus: 'retracted', reason: 'Synthetic integration lifecycle complete.' }))
    const target = (await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic Merge Target' }))).entity
    const merge = await requireOk(await app.mergeEntities({ sourceEntityId: createdEntity.id, targetEntityId: target.id, reason: 'Synthetic integration merge.' }))
    await requireOk(await app.undoMerge({ mergeEventId: merge.id, reason: 'Synthetic integration undo.' }))

    const repository = new DrizzleKnowledgeRepository(requireDatabase())
    for (const subject of [{ kind: 'entity', id: createdEntity.id }, { kind: 'source', id: source.id }, { kind: 'claim', id: claim.id }] satisfies KnowledgeRevisionSubject[]) {
      const revisions = await repository.listRevisions(owner, subject)
      const events = await repository.listMutationEvents(owner, subject)
      expect(revisions.length).toBeGreaterThan(0)
      expect(events).toHaveLength(revisions.length)
      const byFingerprint = new Map(events.map(event => [event.newRevisionFingerprint, event]))
      for (const revision of revisions) {
        assertValidKnowledgeRevision(revision)
        expect(revision.contentHash).toBe(HASH(revision.canonicalSnapshot))
        const event = byFingerprint.get(revision.revisionFingerprint)
        expect(event).toBeDefined()
        assertValidKnowledgeMutationEvent(event!)
        expect(event).toMatchObject({ revisionId: revision.id, revisionNumber: revision.revisionNumber, previousRevisionFingerprint: revision.previousRevisionFingerprint, operations: revision.operations })
      }
    }
    const history = await getKnowledgeRevisionHistory(owner, { kind: 'claim', id: String(claim.id) }, repository)
    expect(history).toMatchObject({ rawSnapshotIncluded: false, automaticPublication: false, productionActivation: false, automaticTrainingAdmission: false })
    const projected = JSON.stringify(history)
    expect(projected).not.toContain('canonicalSnapshot')
    expect(projected).not.toContain(sentinelExcerpt)
    expect(projected).not.toContain(sentinelLocator)
    await expect(getKnowledgeRevisionHistory(owners[1], { kind: 'entity', id: String(createdEntity.id) }, repository)).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' })
    await expect(service(owners[1]).addAlias({ entityId: createdEntity.id, alias: 'Cross owner must not write' })).resolves.toMatchObject({ status: 'rejected' })
  }, 30_000)

  it('rolls back a real SQL mutation when its paired immutable event append fails', async () => {
    const owner = owners[0]
    const beforeEntities = await countRows('knowledgeEntities', owner)
    const beforeRevisions = await countRows('knowledgeSubjectRevisions', owner)
    const beforeEvents = await countRows('knowledgeMutationEvents', owner)
    const app = service(owner, failureRepository())
    await expect(app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic forced rollback' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await countRows('knowledgeEntities', owner)).toBe(beforeEntities)
    expect(await countRows('knowledgeSubjectRevisions', owner)).toBe(beforeRevisions)
    expect(await countRows('knowledgeMutationEvents', owner)).toBe(beforeEvents)
  }, 30_000)

  it('serializes parallel alias writes; any failed call leaves no partial state before a safe fixture retry', async () => {
    const owner = owners[0]
    const app = service(owner)
    const entity = (await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic concurrent alias subject' }))).entity
    const aliases = [`Synthetic concurrent alias one ${randomUUID()}`, `Synthetic concurrent alias two ${randomUUID()}`]
    const attempts = await Promise.allSettled(aliases.map(alias => app.addAlias({ entityId: entity.id, alias })))
    const repo = new DrizzleKnowledgeRepository(requireDatabase())
    const successfulAliases = attempts.flatMap((attempt, index) => attempt.status === 'fulfilled' && attempt.value.status === 'ok' ? [aliases[index]!] : [])
    const aliasesAfterRace = await repo.listEntityAliases(owner, entity.id)
    const revisionsAfterRace = await repo.listRevisions(owner, { kind: 'entity', id: entity.id })
    const eventsAfterRace = await repo.listMutationEvents(owner, { kind: 'entity', id: entity.id })
    expect(aliasesAfterRace.map(row => row.alias).sort()).toEqual([...successfulAliases].sort())
    expect(revisionsAfterRace).toHaveLength(1 + successfulAliases.length)
    expect(eventsAfterRace).toHaveLength(revisionsAfterRace.length)
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!
      if (attempt.status === 'rejected') {
        const revisionCountBeforeRetry = await countRows('knowledgeSubjectRevisions', owner)
        const eventCountBeforeRetry = await countRows('knowledgeMutationEvents', owner)
        const aliasesBeforeRetry = await repo.listEntityAliases(owner, entity.id)
        if (!aliasesBeforeRetry.some(row => row.alias === aliases[index])) {
          await requireOk(await app.addAlias({ entityId: entity.id, alias: aliases[index]! }))
          expect(await countRows('knowledgeSubjectRevisions', owner)).toBe(revisionCountBeforeRetry + 1)
          expect(await countRows('knowledgeMutationEvents', owner)).toBe(eventCountBeforeRetry + 1)
        }
      } else if (attempt.value.status === 'rejected') {
        throw new Error(`Synthetic alias mutation was rejected: ${attempt.value.code}`)
      }
    }
    const currentAliases = await repo.listEntityAliases(owner, entity.id)
    expect(currentAliases.map(row => row.alias).sort()).toEqual([...aliases].sort())
    const revisions = await repo.listRevisions(owner, { kind: 'entity', id: entity.id })
    expect(revisions.map(row => row.revisionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect((await repo.listMutationEvents(owner, { kind: 'entity', id: entity.id })).map(row => row.revisionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3])
  }, 30_000)

  it('keeps opposing concurrent merges acyclic and pairs every successful merge revision and event', async () => {
    const owner = owners[0]
    const app = service(owner)
    const left = (await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic merge left' }))).entity
    const right = (await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic merge right' }))).entity
    const results = await Promise.allSettled([
      app.mergeEntities({ sourceEntityId: left.id, targetEntityId: right.id, reason: 'Synthetic opposing merge left to right.' }),
      app.mergeEntities({ sourceEntityId: right.id, targetEntityId: left.id, reason: 'Synthetic opposing merge right to left.' }),
    ])
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof app.mergeEntities>>> => result.status === 'fulfilled')
    const successful = fulfilled.filter(result => result.value.status === 'ok')
    expect(successful.length).toBe(1)
    const repository = new DrizzleKnowledgeRepository(requireDatabase())
    const [leftRow, rightRow] = await Promise.all([repository.getEntity(owner, left.id), repository.getEntity(owner, right.id)])
    expect(leftRow).not.toBeNull()
    expect(rightRow).not.toBeNull()
    expect([leftRow!.mergedIntoEntityId, rightRow!.mergedIntoEntityId].filter(value => value !== null)).toHaveLength(successful.length)
    expect(!(leftRow!.mergedIntoEntityId === right.id && rightRow!.mergedIntoEntityId === left.id)).toBe(true)
    const mergedSourceId = successful[0]!.value.status === 'ok' ? successful[0]!.value.value.sourceEntityId : 0
    const failedSource = mergedSourceId === left.id ? rightRow! : leftRow!
    expect(failedSource).toMatchObject({ status: 'active', mergedIntoEntityId: null })
    for (const result of successful) {
      const event = result.value.status === 'ok' ? result.value.value : undefined
      if (!event) continue
      const revisions = await repository.listRevisions(owner, { kind: 'entity', id: event.sourceEntityId })
      const matching = revisions.find(revision => revision.operations.includes('updateEntity'))
      expect(matching).toBeDefined()
      const auditEvent = await repository.getMutationEventForRevision(owner, matching!.revisionFingerprint)
      expect(auditEvent).toMatchObject({ revisionId: matching!.id })
      expect(auditEvent?.newRevisionFingerprint).toBe(matching!.revisionFingerprint)
    }
  }, 30_000)

  it('holds a repeatable read-only snapshot across another connection commit and rejects writes', async () => {
    const owner = owners[0]
    const app = service(owner)
    const entity = (await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: 'Synthetic repeatable read subject' }))).entity
    const repository = new DrizzleKnowledgeRepository(requireDatabase())
    const newAlias = `Synthetic visible after snapshot ${randomUUID()}`

    await repository.transaction(async readOnly => {
      const entityBefore = await readOnly.getEntity(owner, entity.id)
      const aliasesBefore = await readOnly.listEntityAliases(owner, entity.id)
      const revisionsBefore = await readOnly.listRevisions(owner, { kind: 'entity', id: entity.id })
      const revisionHeadsBefore = await readOnly.listRevisionHeads(owner, 2_001)
      expect(entityBefore).not.toBeNull()
      await requireOk(await service(owner).addAlias({ entityId: entity.id, alias: newAlias }))
      const entityDuring = await readOnly.getEntity(owner, entity.id)
      const aliasesDuring = await readOnly.listEntityAliases(owner, entity.id)
      const revisionsDuring = await readOnly.listRevisions(owner, { kind: 'entity', id: entity.id })
      const revisionHeadsDuring = await readOnly.listRevisionHeads(owner, 2_001)
      expect(entityDuring).toEqual(entityBefore)
      expect(aliasesDuring).toEqual(aliasesBefore)
      expect(revisionsDuring).toEqual(revisionsBefore)
      expect(revisionHeadsDuring).toEqual(revisionHeadsBefore)
    }, { consistentReadOnly: true })

    expect((await repository.listEntityAliases(owner, entity.id)).map(row => row.alias)).toContain(newAlias)
    expect((await repository.listRevisionHeads(owner, 2_001)).find(head => head.subjectKind === 'entity' && head.subjectId === entity.id)?.revisionNumber).toBe(2)
    const revisionCountBeforeRejectedWrite = await countRows('knowledgeSubjectRevisions', owner)
    const eventCountBeforeRejectedWrite = await countRows('knowledgeMutationEvents', owner)
    const forbiddenAlias = `Synthetic forbidden readonly write ${randomUUID()}`
    let writeFailure: unknown
    try {
      await repository.transaction(readOnly => readOnly.insertEntityAlias({
        ownerUserId: owner,
        entityId: entity.id,
        alias: forbiddenAlias,
        aliasNormalized: forbiddenAlias.toLowerCase(),
        locale: null,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      }).then(() => undefined), { consistentReadOnly: true })
    } catch (error) {
      writeFailure = error
    }
    expect(hasMysqlReadOnlyError(writeFailure)).toBe(true)
    expect((await repository.listEntityAliases(owner, entity.id)).map(row => row.alias)).not.toContain(forbiddenAlias)
    expect(await countRows('knowledgeSubjectRevisions', owner)).toBe(revisionCountBeforeRejectedWrite)
    expect(await countRows('knowledgeMutationEvents', owner)).toBe(eventCountBeforeRejectedWrite)
  }, 30_000)

  it('validates exact SQL revision heads and paired ledger integrity without returning snapshots', async () => {
    const owner = owners[0]
    const otherOwner = owners[1]
    const app = service(owner)
    const entity = (await requireOk(await app.createEntity({ entityType: 'Organization', canonicalName: `Synthetic revision head ${randomUUID()}` }))).entity
    for (let index = 0; index < 30; index += 1) {
      await requireOk(await app.addAlias({ entityId: entity.id, alias: `Synthetic revision head alias ${index} ${randomUUID()}` }))
    }

    const repository = new DrizzleKnowledgeRepository(requireDatabase())
    const subject = { kind: 'entity', id: entity.id } as const
    const head = await repository.getRevisionHead(owner, subject)
    expect(head).not.toBeNull()
    expect(head!.revisionNumber).toBe(31)
    expect((await repository.listRevisions(owner, subject)).map(revision => revision.revisionNumber)).toHaveLength(26)

    const headSummaries = await repository.listRevisionHeads(owner, 2_001)
    const summary = headSummaries.find(item => item.subjectKind === 'entity' && item.subjectId === entity.id)
    expect(summary).toEqual({
      ownerUserId: owner,
      subjectKind: 'entity',
      subjectId: entity.id,
      revisionNumber: head!.revisionNumber,
      contentHash: head!.contentHash,
      revisionFingerprint: head!.revisionFingerprint,
    })
    expect(Object.keys(summary ?? {}).sort()).toEqual(['contentHash', 'ownerUserId', 'revisionFingerprint', 'revisionNumber', 'subjectId', 'subjectKind'])
    expect(await repository.listRevisionHeads(otherOwner, 2_001)).toEqual([])

    const originalSnapshot = head!.canonicalSnapshot
    const badSnapshot = `${originalSnapshot} `
    try {
      await requireDatabase().update(schema.knowledgeSubjectRevisions).set({ canonicalSnapshot: badSnapshot }).where(and(
        eq(schema.knowledgeSubjectRevisions.ownerUserId, owner),
        eq(schema.knowledgeSubjectRevisions.id, head!.id),
      ))
      await expect(repository.listRevisionHeads(owner, 2_001)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    } finally {
      await requireDatabase().update(schema.knowledgeSubjectRevisions).set({ canonicalSnapshot: originalSnapshot }).where(and(
        eq(schema.knowledgeSubjectRevisions.ownerUserId, owner),
        eq(schema.knowledgeSubjectRevisions.id, head!.id),
      ))
    }

    const originalRevisionFingerprint = head!.revisionFingerprint
    const badRevisionFingerprint = 'f'.repeat(64)
    try {
      await requireDatabase().update(schema.knowledgeSubjectRevisions).set({ revisionFingerprint: badRevisionFingerprint }).where(and(
        eq(schema.knowledgeSubjectRevisions.ownerUserId, owner),
        eq(schema.knowledgeSubjectRevisions.id, head!.id),
      ))
      await expect(repository.listRevisionHeads(owner, 2_001)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    } finally {
      await requireDatabase().update(schema.knowledgeSubjectRevisions).set({ revisionFingerprint: originalRevisionFingerprint }).where(and(
        eq(schema.knowledgeSubjectRevisions.ownerUserId, owner),
        eq(schema.knowledgeSubjectRevisions.id, head!.id),
      ))
    }

    const event = await repository.getMutationEventForRevision(owner, originalRevisionFingerprint)
    expect(event).not.toBeNull()
    const originalEventFingerprint = event!.eventFingerprint
    try {
      await requireDatabase().update(schema.knowledgeMutationEvents).set({ eventFingerprint: 'e'.repeat(64) }).where(and(
        eq(schema.knowledgeMutationEvents.ownerUserId, owner),
        eq(schema.knowledgeMutationEvents.id, event!.id),
      ))
      await expect(repository.listRevisionHeads(owner, 2_001)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    } finally {
      await requireDatabase().update(schema.knowledgeMutationEvents).set({ eventFingerprint: originalEventFingerprint }).where(and(
        eq(schema.knowledgeMutationEvents.ownerUserId, owner),
        eq(schema.knowledgeMutationEvents.id, event!.id),
      ))
    }
  }, 30_000)

  it('binds builder-produced dataset and canonical prompt anchors to a real Knowledge revision and reads private coverage', async () => {
    const fixture = await createNativeBindingFixture(owners[0])
    expect(fixture.promptText).not.toBe('Will ALPHA ＆ beta appear in the answer?')
    expect(fixture.promptHash).toBe(HASH('will alpha & beta appear in the answer?'))

    const dataset = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, bindingInput(fixture, 'geo_dataset', fixture.datasetId, 'bind', null, `dataset-bind-${randomUUID()}`), new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()), NOW)
    const prompt = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, bindingInput(fixture, 'benchmark_prompt', fixture.promptVersionId, 'bind', null, `prompt-bind-${randomUUID()}`), new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()), NOW)
    expect(dataset).toMatchObject({ binding: { consumerKind: 'geo_dataset', consumerId: fixture.datasetId, consumerVersion: fixture.datasetFingerprint, consumerContentHash: fixture.datasetFingerprint, revisionFingerprint: fixture.revisionFingerprint, operation: 'bind', sequenceNumber: 1 }, replayed: false, automaticTrainingAdmission: false, automaticPublication: false, productionActivation: false })
    expect(prompt).toMatchObject({ binding: { consumerKind: 'benchmark_prompt', consumerId: fixture.promptVersionId, consumerVersion: String(fixture.promptVersionNumber), consumerContentHash: fixture.promptHash, revisionFingerprint: fixture.revisionFingerprint, operation: 'bind', sequenceNumber: 1 }, replayed: false, automaticTrainingAdmission: false, automaticPublication: false, productionActivation: false })

    const repo = new DrizzleKnowledgeConsumerBindingRepository(requireDatabase())
    const workspace = await repo.readOnly(tx => readKnowledgeConsumerBindingWorkspace(fixture.ownerUserId, tx))
    const coverage = workspace.coverage
    const datasetConsumers = coverage.find(row => row.category === 'dataset')?.consumers ?? []
    const promptConsumers = coverage.find(row => row.category === 'benchmark_prompt')?.consumers ?? []
    expect(datasetConsumers).toEqual(expect.arrayContaining([expect.objectContaining({ consumerId: `geo_dataset:${fixture.datasetId}`, contentHash: fixture.datasetFingerprint, dependencies: [expect.objectContaining({ kind: 'entity', id: fixture.subject.id, revisionFingerprint: fixture.revisionFingerprint })] })]))
    expect(promptConsumers).toEqual(expect.arrayContaining([expect.objectContaining({ consumerId: `benchmark_prompt:${fixture.promptVersionId}`, contentHash: fixture.promptHash, dependencies: [expect.objectContaining({ kind: 'entity', id: fixture.subject.id, revisionFingerprint: fixture.revisionFingerprint })] })]))
    expect(workspace.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ consumerKind: 'geo_dataset', consumerId: fixture.datasetId, nativeAvailability: 'present' }),
      expect.objectContaining({ consumerKind: 'benchmark_prompt', consumerId: fixture.promptVersionId, nativeAvailability: 'present' }),
    ]))
    expect(JSON.stringify(workspace)).not.toContain(fixture.promptText)
    expect(JSON.stringify(workspace)).not.toContain('Will   ALPHA')
  }, 30_000)

  it('replays the same key, rejects key reuse, and serializes binding CAS across two MySQL connections', async () => {
    const fixture = await createNativeBindingFixture(owners[0])
    const primary = bindingInput(fixture, 'geo_dataset', fixture.datasetId, 'bind', null, `cas-bind-${randomUUID()}`)
    const secondary = { ...primary, idempotencyKey: `cas-bind-${randomUUID()}` }
    const bindingsBefore = await countBindingRows('knowledgeConsumerBindings', fixture.ownerUserId)
    const headsBefore = await countBindingRows('knowledgeConsumerBindingHeads', fixture.ownerUserId)
    const connectionA = await mysql.createConnection({ socketPath, user: 'root', database: permittedDatabase, charset: 'utf8mb4', timezone: 'Z' })
    const connectionB = await mysql.createConnection({ socketPath, user: 'root', database: permittedDatabase, charset: 'utf8mb4', timezone: 'Z' })
    try {
      const databaseA = drizzle(connectionA, { schema, mode: 'default' })
      const databaseB = drizzle(connectionB, { schema, mode: 'default' })
      const [resultA, resultB] = await Promise.all([
        connectionA.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS `id`'),
        connectionB.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS `id`'),
      ])
      const connectionIdA = Number(resultA[0][0]?.id)
      const connectionIdB = Number(resultB[0][0]?.id)
      expect(Number.isSafeInteger(connectionIdA) && connectionIdA > 0).toBe(true)
      expect(Number.isSafeInteger(connectionIdB) && connectionIdB > 0).toBe(true)
      expect(connectionIdA).not.toBe(connectionIdB)
      const attempts = await Promise.allSettled([
        mutateKnowledgeConsumerBinding(fixture.ownerUserId, primary, new DrizzleKnowledgeConsumerBindingRepository(databaseA), NOW),
        mutateKnowledgeConsumerBinding(fixture.ownerUserId, secondary, new DrizzleKnowledgeConsumerBindingRepository(databaseB), NOW),
      ])
      const fulfilled = attempts.flatMap((attempt, index) => attempt.status === 'fulfilled' ? [{ input: [primary, secondary][index]!, value: attempt.value }] : [])
      const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toMatchObject({ code: 'CONFLICT' })
      const winner = fulfilled[0]!
      expect(winner.value.replayed).toBe(false)
      const replay = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, winner.input, new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()), NOW)
      expect(replay).toMatchObject({ replayed: true, binding: { id: winner.value.binding.id, bindingFingerprint: winner.value.binding.bindingFingerprint } })

      const collision = { ...winner.input, consumerId: fixture.promptVersionId, consumerKind: 'benchmark_prompt' as const }
      await expect(mutateKnowledgeConsumerBinding(fixture.ownerUserId, collision, new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()), NOW)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await countBindingRows('knowledgeConsumerBindings', fixture.ownerUserId)).toBe(bindingsBefore + 1)
      expect(await countBindingRows('knowledgeConsumerBindingHeads', fixture.ownerUserId)).toBe(headsBefore + 1)
      const pointer = await new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()).getBindingHead(fixture.ownerUserId, winner.input)
      expect(pointer).toMatchObject({ id: winner.value.binding.id, sequenceNumber: 1, bindingFingerprint: winner.value.binding.bindingFingerprint })
    } finally {
      await Promise.all([connectionA.end(), connectionB.end()])
    }
  }, 30_000)

  it('retains missing native anchors as stale and permits revoke without the native row', async () => {
    const fixture = await createNativeBindingFixture(owners[0])
    const repo = new DrizzleKnowledgeConsumerBindingRepository(requireDatabase())
    const input = bindingInput(fixture, 'geo_dataset', fixture.datasetId, 'bind', null, `missing-native-${randomUUID()}`)
    const bound = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, input, repo, NOW)
    const before = await createKnowledgeImpactPreview(fixture.ownerUserId, fixture.subject, new DrizzleKnowledgeRepository(requireDatabase()))
    await requireDatabase().delete(schema.geoOutcomeDatasetManifests).where(and(
      eq(schema.geoOutcomeDatasetManifests.id, fixture.datasetId),
      eq(schema.geoOutcomeDatasetManifests.ownerUserId, fixture.ownerUserId),
    ))

    const workspace = await repo.readOnly(tx => readKnowledgeConsumerBindingWorkspace(fixture.ownerUserId, tx))
    const missing = workspace.coverage
    const datasetCoverage = missing.find(row => row.category === 'dataset')!
    expect(datasetCoverage.limitationCodes).toContain('native_consumer_missing')
    expect(datasetCoverage.consumers).toEqual(expect.arrayContaining([expect.objectContaining({ consumerId: `geo_dataset:${fixture.datasetId}`, nativeAvailability: 'missing', contentHash: fixture.datasetFingerprint })]))
    expect(workspace.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ id: bound.binding.id, operation: 'bind', nativeAvailability: 'missing', consumerId: fixture.datasetId })]))
    const stalePreview = await createKnowledgeImpactPreview(fixture.ownerUserId, fixture.subject, new DrizzleKnowledgeRepository(requireDatabase()))
    expect(stalePreview.graphFingerprint).not.toBe(before.graphFingerprint)
    expect(stalePreview.buckets.find(bucket => bucket.category === 'dataset')?.items).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: 'exact_registered_dependency_stale' })]))

    const revoked = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, bindingInput(fixture, 'geo_dataset', fixture.datasetId, 'revoke', bound.binding.bindingFingerprint, `revoke-missing-${randomUUID()}`), repo, NOW)
    expect(revoked).toMatchObject({ binding: { operation: 'revoke', sequenceNumber: 2, previousBindingFingerprint: bound.binding.bindingFingerprint }, replayed: false })
    const afterRevoke = await repo.readOnly(tx => readKnowledgeConsumerBindingWorkspace(fixture.ownerUserId, tx))
    expect(afterRevoke.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ id: revoked.binding.id, consumerId: fixture.datasetId, subjectId: fixture.subject.id, operation: 'revoke', sequenceNumber: 2, nativeAvailability: 'missing' })]))
    const survivingDataset = afterRevoke.coverage.find(row => row.category === 'dataset')?.consumers.find(consumer => consumer.consumerId === `geo_dataset:${fixture.datasetId}`)
    expect(survivingDataset?.dependencies ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: fixture.subject.kind, id: fixture.subject.id })]))
    expect((survivingDataset?.dependencies ?? []).length).toBeGreaterThan(0)
  }, 30_000)

  it('reads native prompt catalog pages from canonical SQL anchors, scopes owners, and fails closed on a broken parent', async () => {
    const [ownerInsert] = await requireDatabase().insert(schema.users).values({ openId: `synthetic-catalog-a-${randomUUID()}`, role: 'admin' }).$returningId()
    const [otherOwnerInsert] = await requireDatabase().insert(schema.users).values({ openId: `synthetic-catalog-b-${randomUUID()}`, role: 'admin' }).$returningId()
    if (!ownerInsert || !otherOwnerInsert) throw new Error('Synthetic catalog owners were not persisted.')
    const ownerUserId = ownerInsert.id
    const otherOwnerUserId = otherOwnerInsert.id
    const makeProject = async (owner: number, suffix: string) => {
      const projectInput = prepareProject({
        name: `Synthetic native catalog ${suffix} ${randomUUID()}`,
        canonicalWebsiteUrl: `https://catalog-${suffix}-${randomUUID()}.example.com`,
        locale: 'en', brandName: `Catalog ${suffix} Brand ${randomUUID()}`, brandAliases: [], competitorBrands: [],
      })
      const [inserted] = await requireDatabase().insert(schema.llmVisibilityProjects).values({ ...projectInput, ownerUserId: owner, status: 'active' }).$returningId()
      if (!inserted) throw new Error('Synthetic canonical catalog project was not persisted.')
      return inserted.id
    }
    const projectId = await makeProject(ownerUserId, 'owner')
    const otherProjectId = await makeProject(otherOwnerUserId, 'other')
    const registry = createDrizzleVisibilityRegistryRepository(requireDatabase())
    const anchors: Array<{ id: number, versionNumber: number, promptHash: string, promptText: string }> = []
    for (let index = 0; index < 26; index += 1) {
      const promptText = `  SYNTHETIC PRIVATE CATALOG PROMPT ${index} ${randomUUID()}  `
      const queryInput = prepareQuery({ projectId, promptText, intent: `synthetic catalog ${index}`, locale: 'en', active: true })
      const [queryInsert] = await requireDatabase().insert(schema.llmVisibilityQueries).values({ ...queryInput, ownerUserId }).$returningId()
      if (!queryInsert) throw new Error('Synthetic canonical catalog query was not persisted.')
      const [query] = await requireDatabase().select().from(schema.llmVisibilityQueries).where(and(
        eq(schema.llmVisibilityQueries.ownerUserId, ownerUserId),
        eq(schema.llmVisibilityQueries.projectId, projectId),
        eq(schema.llmVisibilityQueries.id, queryInsert.id),
      )).limit(1)
      if (!query) throw new Error('Synthetic canonical catalog query could not be reloaded.')
      const ensured = await ensurePromptVersion(registry, query)
      anchors.push({ id: ensured.version.id, versionNumber: ensured.version.versionNumber, promptHash: ensured.version.promptHash, promptText: ensured.version.promptText })
    }

    const repo = new DrizzleKnowledgeConsumerBindingRepository(requireDatabase())
    const first = await repo.readOnly(tx => readKnowledgeConsumerCatalog(ownerUserId, { kind: 'benchmark_prompt' }, tx))
    expect(first.items).toHaveLength(25)
    expect(first.nextAfterId).toBe(anchors[24]!.id)
    expect(first.items.map(item => item.consumerId)).toEqual(anchors.slice(0, 25).map(anchor => anchor.id))
    expect(first.items.map(item => item.consumerVersion)).toEqual(anchors.slice(0, 25).map(anchor => String(anchor.versionNumber)))
    expect(first.items.map(item => item.consumerContentHash)).toEqual(anchors.slice(0, 25).map(anchor => anchor.promptHash))
    expect(first.rawTextIncluded).toBe(false)
    expect(JSON.stringify(first)).not.toContain(anchors[0]!.promptText)
    expect(first.items.every(item => !Object.hasOwn(item, 'promptText'))).toBe(true)

    const second = await repo.readOnly(tx => readKnowledgeConsumerCatalog(ownerUserId, { kind: 'benchmark_prompt', afterId: String(first.nextAfterId) }, tx))
    expect(second.items).toHaveLength(1)
    expect(second.items[0]).toEqual({ consumerKind: 'benchmark_prompt', consumerId: anchors[25]!.id, consumerVersion: String(anchors[25]!.versionNumber), consumerContentHash: anchors[25]!.promptHash })
    expect(second.nextAfterId).toBeNull()
    const wrongOwner = await repo.readOnly(tx => readKnowledgeConsumerCatalog(otherOwnerUserId, { kind: 'benchmark_prompt' }, tx))
    expect(wrongOwner.items).toEqual([])
    expect(wrongOwner.nextAfterId).toBeNull()

    const corruptedPrompt = anchors[0]!
    try {
      await requireDatabase().update(schema.llmVisibilityPromptVersions).set({ projectId: otherProjectId }).where(and(
        eq(schema.llmVisibilityPromptVersions.ownerUserId, ownerUserId),
        eq(schema.llmVisibilityPromptVersions.id, corruptedPrompt.id),
      ))
      await expect(repo.readOnly(tx => readKnowledgeConsumerCatalog(ownerUserId, { kind: 'benchmark_prompt' }, tx))).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    } finally {
      await requireDatabase().update(schema.llmVisibilityPromptVersions).set({ projectId }).where(and(
        eq(schema.llmVisibilityPromptVersions.ownerUserId, ownerUserId),
        eq(schema.llmVisibilityPromptVersions.id, corruptedPrompt.id),
      ))
    }
  }, 30_000)

  it('keeps native anchors, heads, commands and subjects owner-scoped', async () => {
    const fixture = await createNativeBindingFixture(owners[0])
    const ownerRepo = new DrizzleKnowledgeConsumerBindingRepository(requireDatabase())
    const input = bindingInput(fixture, 'benchmark_prompt', fixture.promptVersionId, 'bind', null, `owner-scope-${randomUUID()}`)
    await mutateKnowledgeConsumerBinding(fixture.ownerUserId, input, ownerRepo, NOW)
    const otherOwner = owners[1]
    const otherRepo = new DrizzleKnowledgeConsumerBindingRepository(requireDatabase())

    expect(await otherRepo.getBindingHead(otherOwner, input)).toBeNull()
    expect(await otherRepo.getCommand(otherOwner, input.idempotencyKey)).toBeNull()
    expect(await otherRepo.getNativeAnchor(otherOwner, 'geo_dataset', fixture.datasetId)).toBeNull()
    expect(await otherRepo.getNativeAnchor(otherOwner, 'benchmark_prompt', fixture.promptVersionId)).toBeNull()
    const otherWorkspace = await otherRepo.readOnly(tx => readKnowledgeConsumerBindingWorkspace(otherOwner, tx))
    expect(otherWorkspace.bindings).toEqual([])
    expect(otherWorkspace.coverage.find(row => row.category === 'dataset')?.consumers).toEqual([])
    expect(otherWorkspace.coverage.find(row => row.category === 'benchmark_prompt')?.consumers).toEqual([])
    await expect(mutateKnowledgeConsumerBinding(otherOwner, input, otherRepo, NOW)).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' })
  }, 30_000)

  it('rolls back the immutable binding and current-head pointer if failure follows both SQL writes', async () => {
    const fixture = await createNativeBindingFixture(owners[0])
    const input = bindingInput(fixture, 'geo_dataset', fixture.datasetId, 'bind', null, `rollback-binding-${randomUUID()}`)
    const beforeBindings = await countBindingRows('knowledgeConsumerBindings', fixture.ownerUserId)
    const beforeHeads = await countBindingRows('knowledgeConsumerBindingHeads', fixture.ownerUserId)
    const beforeRevisions = await countRows('knowledgeSubjectRevisions', fixture.ownerUserId)
    await expect(mutateKnowledgeConsumerBinding(fixture.ownerUserId, input, failingAfterBindingAppend(requireDatabase()), NOW)).rejects.toThrow('SYNTHETIC_BINDING_POST_APPEND_ABORT')
    expect(await countBindingRows('knowledgeConsumerBindings', fixture.ownerUserId)).toBe(beforeBindings)
    expect(await countBindingRows('knowledgeConsumerBindingHeads', fixture.ownerUserId)).toBe(beforeHeads)
    expect(await countRows('knowledgeSubjectRevisions', fixture.ownerUserId)).toBe(beforeRevisions)
    expect(await new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()).getBindingHead(fixture.ownerUserId, input)).toBeNull()
    expect(await new DrizzleKnowledgeConsumerBindingRepository(requireDatabase()).getCommand(fixture.ownerUserId, input.idempotencyKey)).toBeNull()
  }, 30_000)

  it('keeps command keys case-sensitive and rejects corrupted head pointers or key hashes', async () => {
    const fixture = await createNativeBindingFixture(owners[0])
    const repo = new DrizzleKnowledgeConsumerBindingRepository(requireDatabase())
    const datasetInput = bindingInput(fixture, 'geo_dataset', fixture.datasetId, 'bind', null, 'Case-Key-Binding-001')
    const promptInput = bindingInput(fixture, 'benchmark_prompt', fixture.promptVersionId, 'bind', null, 'case-key-binding-001')
    const dataset = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, datasetInput, repo, NOW)
    const prompt = await mutateKnowledgeConsumerBinding(fixture.ownerUserId, promptInput, repo, NOW)
    expect(prompt.binding.id).not.toBe(dataset.binding.id)
    expect(await repo.getCommand(fixture.ownerUserId, datasetInput.idempotencyKey)).toMatchObject({ id: dataset.binding.id, idempotencyKey: datasetInput.idempotencyKey })
    expect(await repo.getCommand(fixture.ownerUserId, promptInput.idempotencyKey)).toMatchObject({ id: prompt.binding.id, idempotencyKey: promptInput.idempotencyKey })

    try {
      await requireDatabase().update(schema.knowledgeConsumerBindingHeads).set({ bindingFingerprint: 'a'.repeat(64) }).where(and(
        eq(schema.knowledgeConsumerBindingHeads.ownerUserId, fixture.ownerUserId),
        eq(schema.knowledgeConsumerBindingHeads.bindingId, dataset.binding.id),
      ))
      await expect(repo.getBindingHead(fixture.ownerUserId, datasetInput)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    } finally {
      await requireDatabase().update(schema.knowledgeConsumerBindingHeads).set({ bindingFingerprint: dataset.binding.bindingFingerprint }).where(and(
        eq(schema.knowledgeConsumerBindingHeads.ownerUserId, fixture.ownerUserId),
        eq(schema.knowledgeConsumerBindingHeads.bindingId, dataset.binding.id),
      ))
    }

    const [storedPromptBinding] = await requireDatabase().select().from(schema.knowledgeConsumerBindings).where(and(
      eq(schema.knowledgeConsumerBindings.ownerUserId, fixture.ownerUserId),
      eq(schema.knowledgeConsumerBindings.id, prompt.binding.id),
    )).limit(1)
    expect(storedPromptBinding).toBeDefined()
    try {
      await requireDatabase().update(schema.knowledgeConsumerBindings).set({ idempotencyKeyHash: 'b'.repeat(64) }).where(and(
        eq(schema.knowledgeConsumerBindings.ownerUserId, fixture.ownerUserId),
        eq(schema.knowledgeConsumerBindings.id, prompt.binding.id),
      ))
      await expect(repo.listBindingHeads(fixture.ownerUserId, 2_001)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    } finally {
      await requireDatabase().update(schema.knowledgeConsumerBindings).set({ idempotencyKeyHash: HASH(promptInput.idempotencyKey) }).where(and(
        eq(schema.knowledgeConsumerBindings.ownerUserId, fixture.ownerUserId),
        eq(schema.knowledgeConsumerBindings.id, prompt.binding.id),
      ))
    }
    expect((await repo.listBindingHeads(fixture.ownerUserId, 2_001)).filter(row => row.subjectKind === fixture.subject.kind && row.subjectId === fixture.subject.id)).toHaveLength(2)
  }, 30_000)
})

function hasMysqlReadOnlyError(error: unknown): boolean {
  let current = error
  const seen = new Set<object>()
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown }
    if (candidate.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' || Number(candidate.errno) === 1792) return true
    current = candidate.cause
  }
  return false
}
