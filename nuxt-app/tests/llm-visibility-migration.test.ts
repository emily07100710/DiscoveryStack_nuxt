import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const schema = readFileSync(join(root, 'server/database/schema.ts'), 'utf8')
const migration = readFileSync(join(root, 'server/database/migrations/0013_cuddly_flatman.sql'), 'utf8')

describe('LLM visibility schema/migration alignment', () => {
  const tables = ['llmVisibilityProjects', 'llmVisibilityQueries', 'llmVisibilityRuns', 'llmVisibilityObservations']

  it('defines all four tables in both Drizzle schema and migration snapshot DDL', () => {
    for (const table of tables) { expect(schema).toContain(`mysqlTable('${table}'`); expect(migration).toContain(`CREATE TABLE \`${table}\``) }
    expect(migration).toContain('llm_visibility_queries_project_prompt_unique')
    expect(migration).toContain('llm_visibility_observations_run_query_unique')
    expect(migration).toContain('FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`)')
  })

  it('is DDL-only and contains no provider call, seed, DML, trigger or procedure', () => {
    expect(migration).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|REPLACE|CALL|CREATE\s+TRIGGER|CREATE\s+PROCEDURE)\b/im)
    expect(migration).not.toMatch(/https?:\/\//i)
  })

  it('does not include any raw provider response column', () => {
    expect(schema).not.toMatch(/rawProviderResponse|fullProviderResponse|rawResponse/)
    expect(migration).not.toMatch(/rawProviderResponse|fullProviderResponse|rawResponse/)
    expect(schema).toContain("boundedExcerpt: text('boundedExcerpt')")
    expect(schema).toContain("responseHash: varchar('responseHash'")
  })
})

const journal = JSON.parse(readFileSync(join(root, 'server/database/migrations/meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }
const benchmarkMigrationFiles = readdirSync(join(root, 'server/database/migrations')).filter(file => /^0036_.+\.sql$/u.test(file))
const benchmarkMigrationTag = benchmarkMigrationFiles.length === 1 ? benchmarkMigrationFiles[0]!.replace(/\.sql$/u, '') : null
const benchmarkMigration = benchmarkMigrationTag ? readFileSync(join(root, `server/database/migrations/${benchmarkMigrationTag}.sql`), 'utf8') : ''

describe('LLM visibility benchmark schema/migration alignment', () => {
  const newTables = ['llmVisibilityPromptVersions', 'llmVisibilityCompetitors', 'llmVisibilityBenchmarkRuns', 'llmVisibilityBenchmarkSamples']

  it('locates exactly one generated 0036 migration recorded anywhere in the journal', () => {
    expect(benchmarkMigrationFiles).toHaveLength(1)
    expect(benchmarkMigrationTag).toMatch(/^0036_/u)
    expect(journal.entries.some(entry => entry.tag === benchmarkMigrationTag)).toBe(true)
    for (const table of newTables) {
      expect(schema).toContain(`mysqlTable('${table}'`)
      expect(benchmarkMigration).toContain(`CREATE TABLE \`${table}\``)
    }
  })

  it('includes prompt/competitor and benchmark sample uniqueness plus nullable additive columns', () => {
    for (const identifier of ['llm_vis_prompt_versions_query_version_unique', 'llm_vis_competitors_project_key_unique', 'llm_vis_bench_samples_identity_unique', 'llm_vis_bench_samples_fingerprint_unique']) expect(benchmarkMigration).toContain(identifier)
    expect(benchmarkMigration).toContain('ADD `promptVersionId` int')
    expect(benchmarkMigration).toContain('ADD `citationFreshness` json')
    expect(benchmarkMigration).toContain('fk_llm_vis_observations_prompt_version')
    expect(schema).toContain("benchmarkRunId: int('benchmarkRunId')")
    expect(schema).toContain("sampleIndex: int('sampleIndex')")
  })

  it('freezes brand name, aliases, and measured domain in the benchmark CREATE TABLE', () => {
    const benchmarkTableDdl = benchmarkMigration.match(/CREATE TABLE `llmVisibilityBenchmarkRuns` \([\s\S]*?\n\);/u)?.[0] || ''
    expect(benchmarkTableDdl).toContain('`brandName` varchar(160) NOT NULL')
    expect(benchmarkTableDdl).toContain('`brandAliases` json NOT NULL')
    expect(benchmarkTableDdl).toContain('`measuredDomain` varchar(253) NOT NULL')
  })

  it('is DDL-only and contains no provider call, seed, DML, trigger or procedure', () => {
    expect(benchmarkMigration).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|REPLACE|CALL|CREATE\s+TRIGGER|CREATE\s+PROCEDURE)\b/im)
    expect(benchmarkMigration).not.toMatch(/https?:\/\//i)
  })

  it('does not include any raw provider response column', () => {
    expect(schema).not.toMatch(/rawProviderResponse|fullProviderResponse|rawResponse/)
    expect(benchmarkMigration).not.toMatch(/rawProviderResponse|fullProviderResponse|rawResponse/)
    expect(schema).toContain("boundedExcerpt: text('boundedExcerpt')")
    expect(schema).toContain("responseHash: varchar('responseHash'")
  })
})

describe('TiDB compatibility of generated migrations', () => {
  const migrationsDir = join(root, 'server/database/migrations')
  const sqlFiles = readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()

  it('never gives a json column a literal DEFAULT in any migration SQL', () => {
    expect(sqlFiles.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of sqlFiles) {
      for (const line of readFileSync(join(migrationsDir, file), 'utf8').split('\n')) {
        if (/`[^`]+`\s+json\b[^;]*\bDEFAULT\b/iu.test(line)) offenders.push(`${file}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('declares json defaults in the Drizzle schema with $defaultFn instead of a literal default', () => {
    expect(schema).toContain("limitationCodes: json('limitationCodes').notNull().$defaultFn(() => [])")
    expect(schema).toContain("aliases: json('aliases').notNull().$defaultFn(() => [])")
    expect(schema).not.toMatch(/json\('[^']+'\)(\.notNull\(\))?\.default\(/u)
  })
})
