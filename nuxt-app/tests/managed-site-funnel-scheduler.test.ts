import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
function schedules(env: Record<string, string> = {}): Record<string, string[]> {
  const replaceConfigUrl: ts.TransformerFactory<ts.SourceFile> = context => node => {
    const visit: ts.Visitor = child => ts.isPropertyAccessExpression(child) && child.name.text === 'url' && ts.isMetaProperty(child.expression) && child.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ? ts.factory.createIdentifier('configUrl') : ts.visitEachChild(child, visit, context)
    return ts.visitNode(node, visit) as ts.SourceFile
  }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, transformers: { before: [replaceConfigUrl] } }).outputText
  const module = { exports: {} as any }
  const requireBuiltin = (name: string) => {
    if (name !== 'node:url') throw new Error('The schedule fixture permits only the URL builtin.')
    return { fileURLToPath }
  }
  new Function('require', 'module', 'exports', 'defineNuxtConfig', 'process', 'configUrl', js)(requireBuiltin, module, module.exports, (value: unknown) => value, { env }, new URL('../nuxt.config.ts', import.meta.url).href)
  return module.exports.default.nitro.scheduledTasks
}

const configurableCronKeys = ['MODEL_IMPROVEMENT_CRON', 'GEO_MODELOPS_CRON', 'MANAGED_SITE_EDITOR_CRON', 'MANAGED_SITE_PROVISIONING_CRON', 'SYSTEM_FACTORY_CRON', 'CONTENT_OPERATIONS_MEASUREMENT_CRON', 'CONTENT_OPERATIONS_CRON', 'CONTENT_OPERATIONS_EXECUTION_CRON', 'LLM_VISIBILITY_BENCHMARK_CRON']
const originalTasks = ['model-improvement:collect', 'content-operations:geo-modelops-tick', 'managed-sites:editor-tick', 'managed-sites:provisioning-tick', 'system-factory:provisioning-tick', 'llm-visibility:benchmark-tick', 'content-operations:tick', 'content-operations:execution-tick', 'content-operations:measurement-tick']
const weeklyTask = 'weekly-content:tick'
const learningTask = 'learning-loop:tick'
const weeklyDefaultCron = '*/5 * * * *'

describe('actual Nuxt scheduled task registration', () => {
  it('retains all original tasks and weekly scanning at the actual default cadences', () => {
    const registered = schedules()
    expect(registered[weeklyDefaultCron]).toEqual(['managed-sites:editor-tick', 'managed-sites:provisioning-tick', 'system-factory:provisioning-tick', 'llm-visibility:benchmark-tick', 'content-operations:execution-tick', weeklyTask, learningTask])
    expect(registered['*/15 * * * *']).toEqual(['content-operations:geo-modelops-tick', 'content-operations:tick'])
    expect(registered['*/30 * * * *']).toEqual(['content-operations:measurement-tick'])
    expect(registered['0 18 * * *']).toEqual(['model-improvement:collect'])
    expect(Object.values(registered).flat().sort()).toEqual([...originalTasks, weeklyTask, learningTask].sort())
  })
  it('retains every precise task identity when configured schedules coincide with the fixed weekly cron', () => {
    const env = Object.fromEntries(configurableCronKeys.map(key => [key, weeklyDefaultCron]))
    const registered = schedules(env)
    expect(Object.keys(registered)).toEqual([weeklyDefaultCron])
    expect(registered[weeklyDefaultCron]).toEqual([...originalTasks, weeklyTask, learningTask])
    expect(new Set(registered[weeklyDefaultCron]).size).toBe(originalTasks.length + 2)
  })
  it('keeps the fixed five-minute weekly scan separate when all configurable tasks move to another cron', () => {
    const configuredCron = '*/10 * * * *'
    const env = Object.fromEntries(configurableCronKeys.map(key => [key, configuredCron]))
    const registered = schedules(env)
    expect(Object.keys(registered)).toEqual([configuredCron, weeklyDefaultCron])
    expect(registered[configuredCron]).toEqual(originalTasks)
    expect(registered[weeklyDefaultCron]).toEqual([weeklyTask, learningTask])
    expect(Object.values(registered).flat().sort()).toEqual([...originalTasks, weeklyTask, learningTask].sort())
  })
})
