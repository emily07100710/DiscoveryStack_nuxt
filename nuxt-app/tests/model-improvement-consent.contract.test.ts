import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const analysis = readFileSync(join(root, 'components/landing/AutomaticSiteAnalysis.vue'), 'utf8')
const schema = readFileSync(join(root, 'server/database/schema.ts'), 'utf8')
const migration = readFileSync(join(root, 'server/database/migrations/0009_eager_leo.sql'), 'utf8')

describe('optional model-improvement consent boundary', () => {
  it('shows a separate optional checkbox on the website-analysis form', () => {
    expect(analysis).toContain('<input v-model="lead.modelImprovementConsent" type="checkbox">')
    expect(analysis).toContain('（選填）')
    expect(analysis).toContain('(Optional)')
  })

  it('states that direct contact and sales data are excluded', () => {
    expect(analysis).toContain('不包含姓名、Email、電話或預算')
    expect(analysis).toContain('This excludes your name, email, phone number and budget')
  })

  it('submits the explicit choice without making it a required report field', () => {
    expect(analysis).toContain('modelImprovementConsent: lead.modelImprovementConsent')
    expect(analysis).not.toContain('!lead.modelImprovementConsent')
  })

  it('persists a versioned, timestamped and revocable consent receipt', () => {
    for (const field of ['modelImprovementConsent', 'modelImprovementConsentVersion', 'modelImprovementConsentAt', 'modelImprovementConsentRevokedAt']) {
      expect(schema).toContain(field)
      expect(migration).toContain(`\`${field}\``)
    }
  })
})
