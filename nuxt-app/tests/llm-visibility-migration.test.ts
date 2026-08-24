import { readFileSync } from 'node:fs'
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
