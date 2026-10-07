import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../server/database/migrations/', import.meta.url)
const read = (file: string) => readFileSync(new URL(file, migrationDir), 'utf8')
const previous = JSON.parse(read('meta/0046_snapshot.json'))
const current = JSON.parse(read('meta/0047_snapshot.json'))
const journal = JSON.parse(read('meta/_journal.json'))
const migration = read('0047_live_publication_actions_v1.sql')
const statements = migration.split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean)
const actionTable = current.tables.learningPublicationActions
const actionSql = statements[0]!

const expectedActionColumns = [
  'id', 'ownerUserId', 'clientId', 'authorizationId', 'entryId', 'attemptId', 'runId', 'targetId', 'draftId', 'draftVersion',
  'inputFingerprint', 'draftContentHash', 'evidenceSnapshotHash', 'publicationContentHash', 'publicationIdentityFingerprint',
  'targetConfigurationFingerprint', 'publicationUrlHash', 'authorizationFingerprint', 'sourceFingerprint', 'expectedProjection',
  'beforeProjection', 'afterProjection', 'plannedAction', 'status', 'reasonCode', 'dispatchStartedAt', 'beforeCapturedAt',
  'deliveredAt', 'afterCapturedAt', 'nextAttemptAt', 'receiptFingerprint', 'evidenceFingerprint', 'afterAttemptCount',
  'leaseToken', 'leaseVersion', 'leaseExpiresAt', 'expiresAt', 'reviewStatus', 'reviewFingerprint',
  'reviewEvidenceFingerprint', 'reviewReasonHash', 'reviewedAt', 'createdAt', 'updatedAt',
]

describe('live publication action additive migration', () => {
  it('appends exactly one table and only widens the existing receipt timestamp precision', () => {
    expect(current.prevId).toBe(previous.id)
    expect(Object.keys(current.tables)).toHaveLength(Object.keys(previous.tables).length + 1)
    expect(Object.keys(current.tables).filter((name: string) => !Object.hasOwn(previous.tables, name))).toEqual(['learningPublicationActions'])
    expect(Object.keys(previous.tables).filter((name: string) => !Object.hasOwn(current.tables, name))).toEqual([])

    for (const [name, priorTable] of Object.entries(previous.tables) as Array<[string, Record<string, any>]>) {
      const currentTable = current.tables[name]
      if (name !== 'contentOperationPublicationAttempts') {
        expect(currentTable, name).toEqual(priorTable)
        continue
      }

      const priorCompletedAt = priorTable.columns.completedAt
      expect(priorCompletedAt).toMatchObject({ type: 'timestamp', notNull: false })
      expect(currentTable.columns.completedAt).toEqual({ ...priorCompletedAt, type: 'timestamp(3)' })
      const normalizedCurrent = structuredClone(currentTable)
      normalizedCurrent.columns.completedAt.type = priorCompletedAt.type
      expect(normalizedCurrent, name).toEqual(priorTable)
      expect(currentTable.columns.completedAt.notNull).toBe(priorCompletedAt.notNull)
      expect(currentTable.columns.completedAt.default).toBe(priorCompletedAt.default)
    }
  })

  it('matches the 44-column action table, eight foreign keys, three explicit indexes, and owner-attempt uniqueness', () => {
    expect(Object.keys(actionTable.columns)).toEqual(expectedActionColumns)
    expect(Object.keys(actionTable.columns)).toHaveLength(44)
    const sqlColumns = [...actionSql.split('CONSTRAINT ')[0]!.matchAll(/^\s*`([^`]+)`\s+/gmu)].map(match => match[1])
    expect(sqlColumns).toEqual(expectedActionColumns)
    expect(Object.keys(actionTable.foreignKeys)).toHaveLength(8)
    expect(Object.keys(actionTable.indexes)).toHaveLength(3)

    const ownerAttempt = actionTable.indexes.learning_pub_action_owner_attempt_uq
    expect(ownerAttempt).toMatchObject({ columns: ['ownerUserId', 'attemptId'], isUnique: true })
    expect(actionSql).toContain('CONSTRAINT `learning_pub_action_owner_attempt_uq` UNIQUE(`ownerUserId`,`attemptId`)')

    for (const [name, foreignKey] of Object.entries(actionTable.foreignKeys) as Array<[string, { tableTo: string; columnsFrom: string[]; columnsTo: string[] }]>) {
      const statement = statements.find(value => value.includes(`ADD CONSTRAINT \`${name}\``))
      expect(statement).toContain(`FOREIGN KEY (\`${foreignKey.columnsFrom[0]}\`) REFERENCES \`${foreignKey.tableTo}\`(\`${foreignKey.columnsTo[0]}\`)`)
      expect(foreignKey.columnsFrom).toHaveLength(1)
      expect(foreignKey.columnsTo).toHaveLength(1)
    }

    for (const [name, columns] of Object.entries({
      learning_pub_action_due_idx: ['ownerUserId', 'status', 'nextAttemptAt', 'id'],
      learning_pub_action_retention_idx: ['ownerUserId', 'expiresAt'],
    })) {
      const index = actionTable.indexes[name]
      expect(index.columns).toEqual(columns)
      expect(migration).toContain(`CREATE INDEX \`${name}\` ON \`learningPublicationActions\` (${columns.map(column => `\`${column}\``).join(',')})`)
      expect(index.isUnique).toBe(false)
    }
  })

  it('preserves millisecond timestamp definitions and exact CURRENT_TIMESTAMP defaults', () => {
    const timestampColumns = ['dispatchStartedAt', 'beforeCapturedAt', 'deliveredAt', 'afterCapturedAt', 'nextAttemptAt', 'leaseExpiresAt', 'expiresAt', 'reviewedAt', 'createdAt', 'updatedAt']
    for (const name of timestampColumns) {
      expect(actionTable.columns[name].type).toBe('timestamp(3)')
      expect(actionSql).toContain('`' + name + '` timestamp(3)')
    }
    expect(actionTable.columns.createdAt.default).toBe('CURRENT_TIMESTAMP(3)')
    expect(actionTable.columns.updatedAt.default).toBe('CURRENT_TIMESTAMP(3)')
    expect(actionTable.columns.updatedAt.onUpdate).toBe(true)
    expect(actionSql).toMatch(/`createdAt` timestamp\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)/u)
    expect(actionSql).toMatch(/`updatedAt` timestamp\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\) ON UPDATE CURRENT_TIMESTAMP\(3\)/u)
  })

  it('contains only the new table, the nullable precision widening, its foreign keys, and its indexes', () => {
    expect(statements[0]).toMatch(/^CREATE TABLE `learningPublicationActions`/u)
    const widening = statements.filter(statement => /^ALTER TABLE `contentOperationPublicationAttempts`/u.test(statement))
    expect(widening).toEqual(['ALTER TABLE `contentOperationPublicationAttempts` MODIFY COLUMN `completedAt` timestamp(3);'])
    expect(statements.filter(statement => /^ALTER TABLE `learningPublicationActions` ADD CONSTRAINT/u.test(statement))).toHaveLength(8)
    expect(statements.filter(statement => /^CREATE INDEX `learning_pub_action_/u.test(statement))).toHaveLength(2)
    expect(statements).toHaveLength(12)
    expect(statements.every(statement => /^(?:CREATE TABLE|CREATE INDEX|ALTER TABLE)/u.test(statement))).toBe(true)
    expect(statements.some(statement => /^(?:DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/iu.test(statement))).toBe(false)
  })

  it('appends journal index 47 immediately after the outbox migration with one matching snapshot append', () => {
    const actionIndex = journal.entries.findIndex((entry: { idx: number }) => entry.idx === 47)
    expect(actionIndex).toBe(47)
    expect(journal.entries[actionIndex - 1]).toMatchObject({ idx: 46, tag: '0046_managed_email_outbox_v1' })
    expect(journal.entries[actionIndex]).toMatchObject({ idx: 47, tag: '0047_live_publication_actions_v1', breakpoints: true })
    expect(journal.entries[actionIndex + 1]).toBeUndefined()
    expect(current.prevId).toBe(previous.id)
  })
})
