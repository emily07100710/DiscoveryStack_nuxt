import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd())
const schema = readFileSync(join(root, 'server/database/schema.ts'), 'utf8')
const migration = readFileSync(join(root, 'server/database/migrations/0009_eager_leo.sql'), 'utf8')

describe('optional model-improvement consent receipt boundary', () => {
  it('persists a versioned, timestamped and revocable consent receipt in the private database', () => {
    for (const field of ['modelImprovementConsent', 'modelImprovementConsentVersion', 'modelImprovementConsentAt', 'modelImprovementConsentRevokedAt']) {
      expect(schema).toContain(field)
      expect(migration).toContain(`\`${field}\``)
    }
  })
})
