import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
function schedules(env: Record<string, string> = {}): Record<string, string[]> {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} as any }
  new Function('module', 'exports', 'defineNuxtConfig', 'process', js)(module, module.exports, (value: unknown) => value, { env })
  return module.exports.default.nitro.scheduledTasks
}

describe('actual Nuxt scheduled task registration', () => {
  it('runs paid funnel and editor advancement alongside the system factory at the default cadence', () => {
    expect(schedules()['*/5 * * * *']).toEqual(['managed-sites:editor-tick', 'managed-sites:provisioning-tick', 'system-factory:provisioning-tick'])
    expect(Object.values(schedules()).flat()).toHaveLength(6)
  })
  it('retains every task when all configured cron schedules coincide', () => {
    const env = Object.fromEntries(['MODEL_IMPROVEMENT_CRON', 'GEO_MODELOPS_CRON', 'MANAGED_SITE_EDITOR_CRON', 'MANAGED_SITE_PROVISIONING_CRON', 'SYSTEM_FACTORY_CRON', 'CONTENT_OPERATIONS_MEASUREMENT_CRON'].map(key => [key, '*/10 * * * *']))
    expect(Object.keys(schedules(env))).toEqual(['*/10 * * * *'])
    expect(schedules(env)['*/10 * * * *']).toHaveLength(6)
    expect(new Set(schedules(env)['*/10 * * * *']).size).toBe(6)
  })
})
