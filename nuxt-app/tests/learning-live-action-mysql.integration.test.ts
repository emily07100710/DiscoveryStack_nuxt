import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import { createConnection, type Connection } from 'mysql2/promise'
import { DrizzleLiveActionRepository, type LiveActionInsert } from '../server/learning-loop/live-action-repository'

const enabled = process.env.DS_RUN_LEARNING_LIVE_ACTION_MYSQL_INTEGRATION === '1'
const mysqlDescribe = enabled ? describe : describe.skip
const migrationPath = fileURLToPath(new URL('../server/database/migrations/0047_live_publication_actions_v1.sql', import.meta.url))
const hash = (label: string) => createHash('sha256').update(label).digest('hex')
let connection: Connection | undefined
let secondConnection: Connection | undefined
let repository: DrizzleLiveActionRepository | undefined
let secondRepository: DrizzleLiveActionRepository | undefined
let primary: Scenario
let secondary: Scenario
let race: Scenario
let expiredRun: Scenario
let queuedRun: Scenario
let dryRun: Scenario
let unboundSecondary: Scenario
let legacyAttemptId: number
let legacyCompletedAt: Date

const parentDdl = [
  `CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationClients (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, canonicalSiteOrigin VARCHAR(512) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE learningSourceAuthorizations (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, clientId INT NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationCalendars (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, clientId INT NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationCalendarEntries (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, calendarId INT NOT NULL, jobId INT NULL, draftId INT NULL, evidenceSnapshotHash VARCHAR(128) NOT NULL, contentHash VARCHAR(128) NULL, publicationContentHash VARCHAR(128) NULL, publicationTargetId INT NULL, publicationSlug VARCHAR(160) NULL, publicationPath VARCHAR(512) NULL, publicationIdentityFingerprint VARCHAR(128) NULL) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationPublicationTargets (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, clientId INT NOT NULL, configurationFingerprint VARCHAR(128) NOT NULL, status ENUM('active','paused','revoked') NOT NULL, executionEnabled TINYINT(1) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationCalendarEntryTargets (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, clientId INT NOT NULL, entryId INT NOT NULL, targetId INT NOT NULL, slot INT NOT NULL, bindingFingerprint VARCHAR(128) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationRuns (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, entryId INT NOT NULL, stage ENUM('generation','review_wait','publication','measurement','learning') NOT NULL, state ENUM('queued','processing','retry_wait','succeeded','failed','blocked','cancelled') NOT NULL, leaseOwner VARCHAR(128) NULL, leaseExpiresAt TIMESTAMP NULL) ENGINE=InnoDB`,
  `CREATE TABLE contentOperationPublicationAttempts (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ownerUserId INT NOT NULL, clientId INT NOT NULL, entryId INT NOT NULL, runId INT NOT NULL, targetId INT NOT NULL, mode ENUM('dry_run','execute') NOT NULL, publicationId VARCHAR(160) NOT NULL, publicationSlug VARCHAR(160) NOT NULL, publicationPath VARCHAR(512) NOT NULL, contentHash VARCHAR(128) NOT NULL, publicationContentHash VARCHAR(128) NULL, evidenceSnapshotHash VARCHAR(128) NOT NULL, receiptFingerprint VARCHAR(128) NULL, status ENUM('planned','dry_run_succeeded','delivered','retryable_failure','permanent_failure','blocked') NOT NULL, startedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, completedAt TIMESTAMP NULL) ENGINE=InnoDB`,
  `CREATE TABLE seoGeoContentDrafts (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, jobId INT NOT NULL, version INT NOT NULL, contentHash VARCHAR(128) NOT NULL) ENGINE=InnoDB`,
]

function requireSafeTestTarget(): URL {
  const raw = process.env.DS_LEARNING_LIVE_ACTION_MYSQL_TEST_URL
  if (!raw) throw new Error('Opt-in live-action SQL test requires DS_LEARNING_LIVE_ACTION_MYSQL_TEST_URL.')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Live-action SQL test URL is invalid.') }
  const port = Number(url.port)
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 20000 || port > 65535 || !/^\/ds_live_action_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Live-action SQL test is restricted to mysql://127.0.0.1:<random-port>/ds_live_action_<suffix>.')
  }
  return url
}

type SqlPrimitive = string | number | Date | boolean | null

async function insert(sql: string, values: SqlPrimitive[] = []): Promise<number> {
  const [result] = await connection!.execute(sql, values)
  return Number((result as { insertId?: number }).insertId)
}

type Scenario = {
  ownerId: number; clientId: number; authId: number; calendarId: number; entryId: number; targetId: number; runId: number; attemptId: number; draftId: number; actionId: number
  publicationLease: { runId: number; leaseToken: string }; actionLease: { ownerUserId: number; id: number; leaseToken: string; leaseVersion: number }
  inputFingerprint: string; receiptFingerprint: string; publicationContentHash: string; draftContentHash: string; evidenceSnapshotHash: string; actionInput: LiveActionInsert
}

async function makeScenario(options: { secondary?: boolean; missingBinding?: boolean; actionless?: boolean; mode?: 'dry_run' | 'execute'; runState?: 'queued' | 'processing' | 'retry_wait' | 'blocked' | 'failed' | 'succeeded' } = {}): Promise<Scenario> {
  const ownerId = await insert('INSERT INTO users VALUES ()')
  const otherClient = await insert('INSERT INTO contentOperationClients (ownerUserId, canonicalSiteOrigin) VALUES (?, ?)', [ownerId, 'https://client.example'])
  const authId = await insert('INSERT INTO learningSourceAuthorizations (ownerUserId, clientId) VALUES (?, ?)', [ownerId, otherClient])
  const calendarId = await insert('INSERT INTO contentOperationCalendars (ownerUserId, clientId) VALUES (?, ?)', [ownerId, otherClient])
  const draftId = await insert('INSERT INTO seoGeoContentDrafts (jobId, version, contentHash) VALUES (?, ?, ?)', [9000 + ownerId, 2, hash('b')])
  const primaryTargetId = await insert('INSERT INTO contentOperationPublicationTargets (ownerUserId, clientId, configurationFingerprint, status, executionEnabled) VALUES (?, ?, ?, \'active\', 1)', [ownerId, otherClient, hash('c')])
  const targetId = options.secondary
    ? await insert('INSERT INTO contentOperationPublicationTargets (ownerUserId, clientId, configurationFingerprint, status, executionEnabled) VALUES (?, ?, ?, \'active\', 1)', [ownerId, otherClient, hash('d')])
    : primaryTargetId
  const entryId = await insert('INSERT INTO contentOperationCalendarEntries (ownerUserId, calendarId, jobId, draftId, evidenceSnapshotHash, contentHash, publicationContentHash, publicationTargetId, publicationSlug, publicationPath, publicationIdentityFingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [ownerId, calendarId, 9000 + ownerId, draftId, hash('e'), hash('b'), hash('f'), primaryTargetId, 'primary-slug', '/primary-path', hash('g')])
  if (options.secondary && !options.missingBinding) await insert('INSERT INTO contentOperationCalendarEntryTargets (ownerUserId, clientId, entryId, targetId, slot, bindingFingerprint) VALUES (?, ?, ?, ?, ?, ?)', [ownerId, otherClient, entryId, targetId, 2, hash('binding')])
  const runLease = `pub-lease-${ownerId}-${entryId}`
  const runId = await insert('INSERT INTO contentOperationRuns (ownerUserId, entryId, stage, state, leaseOwner, leaseExpiresAt) VALUES (?, ?, \'publication\', ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 2 MINUTE))', [ownerId, entryId, options.runState || 'processing', runLease])
  const publicationContentHash = options.secondary ? hash('h') : hash('f')
  const publicationIdentityFingerprint = options.secondary ? hash('i') : hash('g')
  const publicationId = options.secondary ? `secondary-${entryId}-${targetId}` : `publication-${entryId}`
  const slug = options.secondary ? `secondary-${entryId}` : 'primary-slug'
  const path = options.secondary ? `/secondary-${entryId}` : '/primary-path'
  const attemptId = await insert('INSERT INTO contentOperationPublicationAttempts (ownerUserId, clientId, entryId, runId, targetId, mode, publicationId, publicationSlug, publicationPath, contentHash, publicationContentHash, evidenceSnapshotHash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'planned\')', [ownerId, otherClient, entryId, runId, targetId, options.mode || 'execute', publicationId, slug, path, hash('b'), publicationContentHash, hash('e')])
  const inputFingerprint = hash(options.secondary ? 'j' : 'k')
  const expiresAt = new Date(Date.now() + 60 * 60_000)
  const actionLeaseToken = `capture-lease-${ownerId}-${entryId}`
  const actionInput: LiveActionInsert = {
    ownerUserId: ownerId, clientId: otherClient, authorizationId: authId, entryId, attemptId, runId, targetId, draftId, draftVersion: 2,
    inputFingerprint, draftContentHash: hash('b'), evidenceSnapshotHash: hash('e'), publicationContentHash,
    publicationIdentityFingerprint, targetConfigurationFingerprint: options.secondary ? hash('d') : hash('c'),
    publicationUrlHash: hash(options.secondary ? 'l' : 'm'), authorizationFingerprint: hash('n'), sourceFingerprint: hash('o'),
    expectedProjection: { titleHash: hash('p') }, beforeProjection: null, afterProjection: null, plannedAction: null,
    status: 'capturing_before', reasonCode: null, dispatchStartedAt: null, beforeCapturedAt: null, deliveredAt: null, afterCapturedAt: null, nextAttemptAt: null,
    receiptFingerprint: null, evidenceFingerprint: null, afterAttemptCount: 0, leaseToken: actionLeaseToken, leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000), expiresAt, reviewStatus: 'pending', reviewFingerprint: null, reviewEvidenceFingerprint: null,
    reviewReasonHash: null, reviewedAt: null,
  }
  const actionRow = options.actionless ? null : (await repository!.reserve(actionInput)).row
  return {
    ownerId, clientId: otherClient, authId, calendarId, entryId, targetId, runId, attemptId, draftId, actionId: actionRow?.id || 0,
    publicationLease: { runId, leaseToken: runLease }, actionLease: { ownerUserId: ownerId, id: actionRow?.id || 0, leaseToken: actionLeaseToken, leaseVersion: actionRow?.leaseVersion ?? 1 },
    inputFingerprint, receiptFingerprint: hash('q'), publicationContentHash, draftContentHash: hash('b'), evidenceSnapshotHash: hash('e'), actionInput,
  }
}

mysqlDescribe('learning live publication action MySQL/TiDB isolated SQL integration', () => {
  beforeAll(async () => {
    const url = requireSafeTestTarget()
    connection = await createConnection({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), multipleStatements: true, timezone: 'Z' })
    await connection.query("SET time_zone = '+00:00'")
    const [tableRows] = await connection.query('SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()')
    if ((tableRows as unknown[]).length !== 0) throw new Error('Disposable live-action integration database must be empty before the one-shot migration test.')
    for (const ddl of parentDdl) await connection.query(ddl)
    const legacy = await makeScenario({ actionless: true })
    legacyAttemptId = legacy.attemptId
    await connection.execute("UPDATE contentOperationPublicationAttempts SET completedAt = '2026-10-05 12:00:00' WHERE id = ?", [legacyAttemptId])
    const [oldRows] = await connection.execute('SELECT completedAt FROM contentOperationPublicationAttempts WHERE id = ?', [legacyAttemptId])
    legacyCompletedAt = (oldRows as Array<{ completedAt: Date }>)[0]!.completedAt
    let migrationSql: string
    try { migrationSql = await readFile(migrationPath, 'utf8') } catch { throw new Error('Required generated 0047_live_publication_actions_v1.sql migration is not present.') }
    if (!migrationSql.includes('learningPublicationActions') || !/`completedAt`\s+timestamp\(3\)/i.test(migrationSql)) throw new Error('0047 migration must include the action table and completedAt precision widening.')
    for (const statement of migrationSql.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await connection.query(statement)
    repository = new DrizzleLiveActionRepository(drizzle(connection, { mode: 'default' }))
    secondConnection = await createConnection({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: 'Z' })
    await secondConnection.query("SET time_zone = '+00:00'")
    secondRepository = new DrizzleLiveActionRepository(drizzle(secondConnection, { mode: 'default' }))
    primary = await makeScenario()
    secondary = await makeScenario({ secondary: true })
    race = await makeScenario({ actionless: true })
    expiredRun = await makeScenario()
    queuedRun = await makeScenario({ runState: 'queued' })
    dryRun = await makeScenario({ mode: 'dry_run' })
    unboundSecondary = await makeScenario({ secondary: true, missingBinding: true })
  }, 30_000)

  afterAll(async () => { await Promise.all([connection?.end(), secondConnection?.end()]); connection = undefined; secondConnection = undefined; repository = undefined; secondRepository = undefined })

  it('applies generated DDL with timestamp(3) defaults and widens legacy receipt precision', async () => {
    const [cols] = await connection!.execute(`SELECT column_name AS column_name, data_type AS data_type, datetime_precision AS datetime_precision, column_default AS column_default FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'learningPublicationActions'`)
    const actionColumns = cols as Array<{ column_name: string; data_type: string; datetime_precision: number | null; column_default: string | null }>
    for (const name of ['createdAt', 'updatedAt', 'dispatchStartedAt', 'beforeCapturedAt', 'deliveredAt', 'afterCapturedAt', 'nextAttemptAt', 'leaseExpiresAt', 'expiresAt', 'reviewedAt']) expect(actionColumns.find(col => col.column_name === name)?.datetime_precision).toBe(3)
    expect(actionColumns.find(col => col.column_name === 'createdAt')?.column_default?.toLowerCase()).toContain('current_timestamp(3)')
    const [attemptCols] = await connection!.execute(`SELECT datetime_precision AS datetime_precision FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'contentOperationPublicationAttempts' AND column_name = 'completedAt'`)
    expect((attemptCols as Array<{ datetime_precision: number }>)[0]?.datetime_precision).toBe(3)
    const [legacyRows] = await connection!.execute('SELECT completedAt FROM contentOperationPublicationAttempts WHERE id = ?', [legacyAttemptId])
    expect((legacyRows as Array<{ completedAt: Date }>)[0]!.completedAt.getTime()).toBe(legacyCompletedAt.getTime())
  })

  it('rejects stale, queued, dry-run, and unbound-route authority; owner-isolates reservations and resolves concurrent replay', async () => {
    await connection!.execute('UPDATE contentOperationRuns SET leaseExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [expiredRun.runId])
    expect(await repository!.saveBefore(expiredRun.actionLease, new Date(Date.now() - 24 * 60 * 60_000), { beforeProjection: { titleHash: hash('r') }, plannedAction: { titleChange: 1 }, beforeCapturedAt: new Date(Date.now() - 24 * 60 * 60_000) }, expiredRun.publicationLease)).toBeNull()
    for (const rejected of [queuedRun, dryRun, unboundSecondary]) {
      expect(await repository!.saveBefore(rejected.actionLease, new Date(), { beforeProjection: { titleHash: hash('r') }, plannedAction: { titleChange: 1 }, beforeCapturedAt: new Date() }, rejected.publicationLease)).toBeNull()
    }

    const primaryInsert = primary.actionInput
    const insertedReplay = await repository!.reserve(primaryInsert)
    expect(insertedReplay.replayed).toBe(true)
    await expect(repository!.reserve({ ...primaryInsert, inputFingerprint: hash('z') })).rejects.toThrow('identity collision')
    expect(await repository!.get(primary.ownerId + 1, primary.actionId)).toBeNull()
    expect((await repository!.findByAttempt(primary.ownerId, primary.attemptId))?.id).toBe(primary.actionId)
    const raceResults = await Promise.all([repository!.reserve(race.actionInput), secondRepository!.reserve(race.actionInput)])
    expect(raceResults.filter(result => !result.replayed)).toHaveLength(1)
    expect(raceResults.filter(result => result.replayed)).toHaveLength(1)
    expect(await repository!.get(race.ownerId, raceResults[0]!.row.id)).not.toBeNull()
  })

  it('captures and dispatches primary and bound secondary targets while clearing the capture lease', async () => {
    for (const s of [primary, secondary]) {
      const before = await repository!.saveBefore(s.actionLease, new Date(), { beforeProjection: { titleHash: hash('r') }, plannedAction: { titleChange: 1 }, beforeCapturedAt: new Date() }, s.publicationLease)
      expect(before?.status).toBe('before_ready')
      const dispatched = await repository!.markDispatch(s.ownerId, s.actionId, s.actionLease.leaseVersion, new Date(), s.publicationLease)
      expect(dispatched?.status).toBe('dispatch_started')
      expect(dispatched?.leaseToken).toBeNull()
      expect(dispatched?.leaseExpiresAt).toBeNull()
    }
  })

  it('requires the exact ordered delivered receipt, fences concurrent after claims and stale/evidence-drifted completion, and reviews immutably', async () => {
    const staleNow = new Date(Date.now() - 24 * 60 * 60_000)
    const [primaryAttemptRows] = await connection!.execute('SELECT completedAt FROM contentOperationPublicationAttempts WHERE id = ?', [primary.attemptId])
    await connection!.execute('UPDATE contentOperationPublicationAttempts SET status = \'delivered\', receiptFingerprint = ?, completedAt = CURRENT_TIMESTAMP(3) WHERE id = ?', [primary.receiptFingerprint, primary.attemptId])
    await connection!.execute('UPDATE contentOperationRuns SET state = \'retry_wait\' WHERE id = ?', [primary.runId])
    const [completedRows] = await connection!.execute('SELECT completedAt FROM contentOperationPublicationAttempts WHERE id = ?', [primary.attemptId])
    const firstDeliveredAt = (completedRows as Array<{ completedAt: Date }>)[0]!.completedAt
    expect(firstDeliveredAt.getTime()).toBeGreaterThanOrEqual((await repository!.get(primary.ownerId, primary.actionId))!.dispatchStartedAt!.getTime())
    expect((primaryAttemptRows as Array<{ completedAt: Date | null }>)[0]?.completedAt).toBeNull()
    const [dispatchRows] = await connection!.execute('SELECT dispatchStartedAt FROM learningPublicationActions WHERE id = ?', [primary.actionId])
    const dispatchStartedAt = (dispatchRows as Array<{ dispatchStartedAt: Date }>)[0]!.dispatchStartedAt
    await connection!.execute('UPDATE contentOperationPublicationAttempts SET completedAt = DATE_SUB(?, INTERVAL 1000 MICROSECOND) WHERE id = ?', [dispatchStartedAt, primary.attemptId])
    const [earlyRows] = await connection!.execute('SELECT completedAt FROM contentOperationPublicationAttempts WHERE id = ?', [primary.attemptId])
    const earlyAt = (earlyRows as Array<{ completedAt: Date }>)[0]!.completedAt
    expect(await repository!.attachReceipt(primary.ownerId, primary.actionId, { inputFingerprint: primary.inputFingerprint, receiptFingerprint: primary.receiptFingerprint, deliveredAt: earlyAt }, new Date())).toBeNull()
    await connection!.execute('UPDATE contentOperationPublicationAttempts SET completedAt = ? WHERE id = ?', [firstDeliveredAt, primary.attemptId])
    const deliveredAt = firstDeliveredAt
    expect(await repository!.attachReceipt(primary.ownerId, primary.actionId, { inputFingerprint: primary.inputFingerprint, receiptFingerprint: hash('x'), deliveredAt }, new Date())).toBeNull()
    const attached = await repository!.attachReceipt(primary.ownerId, primary.actionId, { inputFingerprint: primary.inputFingerprint, receiptFingerprint: primary.receiptFingerprint, deliveredAt }, new Date())
    expect(attached?.status).toBe('awaiting_after')

    const claimResults = await Promise.all([
      repository!.claimAfter(primary.ownerId, primary.actionId, attached!.leaseVersion, 'after-worker-1', staleNow, new Date(Date.now() + 20_000)),
      secondRepository!.claimAfter(primary.ownerId, primary.actionId, attached!.leaseVersion, 'after-worker-2-race', staleNow, new Date(Date.now() + 20_000)),
    ])
    expect(claimResults.filter(Boolean)).toHaveLength(1)
    const claim = claimResults.find(Boolean)!
    expect(claim?.status).toBe('capturing_after')
    const winnerToken = claim!.leaseToken!
    const leaseOne = { ownerUserId: primary.ownerId, id: primary.actionId, leaseToken: winnerToken, leaseVersion: claim!.leaseVersion }
    await connection!.execute('UPDATE contentOperationCalendarEntries SET evidenceSnapshotHash = ? WHERE id = ?', [hash('z'), primary.entryId])
    const driftedAt = new Date()
    const driftedFinish = await repository!.finishAfter(leaseOne, driftedAt, { status: 'observed', afterProjection: { titleHash: hash('s') }, afterCapturedAt: driftedAt, evidenceFingerprint: hash('t'), reasonCode: null, nextAttemptAt: null })
    expect(driftedFinish).toBeNull()
    await connection!.execute('UPDATE contentOperationCalendarEntries SET evidenceSnapshotHash = ? WHERE id = ?', [primary.evidenceSnapshotHash, primary.entryId])
    await connection!.execute('UPDATE learningPublicationActions SET leaseExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [primary.actionId])
    const takeover = await repository!.claimAfter(primary.ownerId, primary.actionId, claim!.leaseVersion, 'after-worker-2', staleNow, new Date(Date.now() + 30_000))
    expect(takeover?.leaseToken).toBe('after-worker-2')
    const staleAt = new Date()
    const staleFinish = await repository!.finishAfter(leaseOne, staleAt, { status: 'observed', afterProjection: { titleHash: hash('s') }, afterCapturedAt: staleAt, evidenceFingerprint: hash('t'), reasonCode: null, nextAttemptAt: null })
    expect(staleFinish).toBeNull()
    const leaseTwo = { ownerUserId: primary.ownerId, id: primary.actionId, leaseToken: 'after-worker-2', leaseVersion: takeover!.leaseVersion }
    const observedAt = new Date()
    const observed = await repository!.finishAfter(leaseTwo, observedAt, { status: 'observed', afterProjection: { titleHash: hash('u') }, afterCapturedAt: observedAt, evidenceFingerprint: hash('v'), reasonCode: null, nextAttemptAt: null })
    expect(observed?.status).toBe('observed')
    const reviewed = await repository!.review(primary.ownerId, primary.actionId, hash('v'), 'approved', hash('w'), hash('x'), new Date())
    expect(reviewed?.reviewStatus).toBe('approved')
    expect(await repository!.review(primary.ownerId, primary.actionId, hash('v'), 'rejected', hash('y'), hash('z'), new Date())).toBeNull()
  })

  it('physically clears expired projections and fences old lease completion', async () => {
    const beforeExpired = await repository!.get(secondary.ownerId, secondary.actionId)
    await connection!.execute('UPDATE learningPublicationActions SET status = \'capturing_after\', afterProjection = ?, leaseToken = ?, leaseVersion = leaseVersion + 1, leaseExpiresAt = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE), expiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [JSON.stringify({ titleHash: hash('r') }), 'cleanup-worker', secondary.actionId])
    expect(await repository!.purgeExpired(secondary.ownerId, new Date(), 10)).toBe(1)
    const cleared = await repository!.get(secondary.ownerId, secondary.actionId)
    expect(cleared).toMatchObject({ status: 'expired', expectedProjection: null, beforeProjection: null, afterProjection: null, plannedAction: null, leaseToken: null, leaseExpiresAt: null })
    const [expiredFields] = await connection!.execute('SELECT expectedProjection, beforeProjection, afterProjection, plannedAction FROM learningPublicationActions WHERE id = ?', [secondary.actionId])
    expect(Object.values((expiredFields as Array<Record<string, unknown>>)[0]!)).toEqual([null, null, null, null])
    const deadLeaseFinish = await repository!.finishAfter({ ownerUserId: secondary.ownerId, id: secondary.actionId, leaseToken: 'cleanup-worker', leaseVersion: (beforeExpired!.leaseVersion || 0) + 2 }, new Date(), { status: 'observed', afterProjection: { titleHash: hash('s') }, afterCapturedAt: new Date(), evidenceFingerprint: hash('t'), reasonCode: null, nextAttemptAt: null })
    expect(deadLeaseFinish).toBeNull()
  })
})
