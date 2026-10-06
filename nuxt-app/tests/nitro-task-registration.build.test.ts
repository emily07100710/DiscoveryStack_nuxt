import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Inspect built code as syntax only. Importing the production server or a task
// could start a scheduler; this test never executes either one.
const configUrl = new URL('../nuxt.config.ts', import.meta.url)
const config = ts.createSourceFile('nuxt.config.ts', readFileSync(configUrl, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const productionArtifact = fileURLToPath(new URL('../.output/server/chunks/nitro/nitro.mjs', import.meta.url))
const bindings = {
  'content-operations:tick': './server/tasks/content-operations-tick.ts',
  'content-operations:execution-tick': './server/tasks/content-operations-execution-tick.ts',
  'llm-visibility:benchmark-tick': './server/tasks/llm-visibility-benchmark-tick.ts',
  'weekly-content:tick': './server/tasks/weekly-content-tick.ts',
  'learning-loop:tick': './server/tasks/learning-loop-tick.ts',
}
type Schedule = { cron: string; tasks: string[] }
type BuiltMetadata = { schedules: Schedule[]; registry: Map<string, string> }
function findNode<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T {
  let result: T | undefined
  const visit = (node: ts.Node) => { if (result) return; if (guard(node)) result = node; else ts.forEachChild(node, visit) }
  visit(root)
  if (!result) throw new Error('Required task metadata was not found; rebuild the production artifact.')
  return result
}
function initializer(root: ts.Node, name: string): ts.Expression {
  const declaration = findNode(root, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
  if (!declaration.initializer) throw new Error(`Task metadata ${name} has no initializer.`)
  return declaration.initializer
}
function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression) ? unwrap(expression.expression) : expression
}
function object(expression: ts.Expression): ts.ObjectLiteralExpression {
  const node = unwrap(expression)
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Task metadata must be a literal object.')
  return node
}
function array(expression: ts.Expression): ts.ArrayLiteralExpression {
  const node = unwrap(expression)
  if (!ts.isArrayLiteralExpression(node)) throw new Error('Task metadata must be a literal array.')
  return node
}
function text(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isIdentifier(node)) return node.text
  throw new Error('Task metadata must have literal names.')
}
function property(expression: ts.Expression, name: string): ts.Expression {
  const entry = object(expression).properties.find((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && text(node.name) === name)
  if (!entry) throw new Error(`Task metadata property ${name} is missing.`)
  return entry.initializer
}
function configuredCron(expression: ts.Expression): string {
  if (ts.isStringLiteral(expression)) return expression.text
  if (!ts.isIdentifier(expression)) throw new Error('Unexpected schedule expression.')
  const value = initializer(config, expression.text)
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.BarBarToken || !ts.isStringLiteral(value.right) || !ts.isPropertyAccessExpression(value.left)) throw new Error('Unexpected configurable cron expression.')
  const name = value.left.name.text
  if (!/^[A-Z_]+_CRON$/.test(name) || value.left.expression.getText(config) !== 'process.env') throw new Error('Only non-secret cron controls may be read.')
  // The build and test phases receive the same explicit cron controls. No
  // runtime config, task payloads, secrets or provider configuration are read.
  return process.env[name] || value.right.text
}
function configuredSchedules(): Schedule[] {
  const loop = findNode(config, (node): node is ts.ForOfStatement => ts.isForOfStatement(node) && node.statement.getText(config).includes('scheduledTasks[cron]'))
  const grouped = new Map<string, string[]>()
  for (const expression of array(loop.expression).elements) {
    const row = array(expression)
    if (row.elements.length !== 2 || !row.elements[0] || !row.elements[1]) throw new Error('Unexpected schedule row.')
    const cron = configuredCron(row.elements[0])
    grouped.set(cron, [...(grouped.get(cron) || []), ...array(row.elements[1]).elements.map(text)])
  }
  return [...grouped].map(([cron, tasks]) => ({ cron, tasks }))
}
function readBuiltMetadata(): BuiltMetadata {
  if (!existsSync(productionArtifact)) throw new Error('Production task artifact is missing. Run the node-server build before this test.')
  const built = ts.createSourceFile('nitro.mjs', readFileSync(productionArtifact, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const schedules = array(initializer(built, 'scheduledTasks')).elements.map(row => ({ cron: text(property(row, 'cron')), tasks: array(property(row, 'tasks')).elements.map(text) }))
  const registry = new Map<string, string>()
  for (const entry of object(initializer(built, 'tasks')).properties) {
    if (!ts.isPropertyAssignment(entry)) throw new Error('Unexpected compiled task registry entry.')
    const resolver = property(entry.initializer, 'resolve')
    const dynamicImport = findNode(resolver, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    if (dynamicImport.arguments.length !== 1 || !dynamicImport.arguments[0]) throw new Error('Task handler has no bounded import path.')
    registry.set(text(entry.name), text(dynamicImport.arguments[0]))
  }
  return { schedules, registry }
}
function assertScheduledRegistration(expected: Schedule[], built: BuiltMetadata): void {
  for (const row of expected) for (const task of row.tasks) {
    if (!built.registry.has(task)) throw new Error(`Configured task ${task} is not registered in the production artifact.`)
    const matching = built.schedules.filter(schedule => schedule.cron === row.cron && schedule.tasks.includes(task))
    if (matching.length !== 1) throw new Error(`Configured task ${task} was dropped or duplicated in its production cron.`)
    const occurrences = built.schedules.flatMap(schedule => schedule.tasks).filter(name => name === task).length
    if (occurrences !== 1) throw new Error(`Configured task ${task} has duplicate production schedules.`)
  }
  const expectedNames = expected.flatMap(row => row.tasks).sort()
  const actualNames = built.schedules.flatMap(row => row.tasks).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('The production scheduler differs from the complete configured task list.')
}

describe('production Nitro task registration', () => {
  it('binds each flat handler to its exact scheduled name through an absolute URL-based path', () => {
    const exported = findNode(config, ts.isExportAssignment)
    if (!ts.isCallExpression(exported.expression) || !exported.expression.arguments[0]) throw new Error('Nuxt config must contain the task registration.')
    const registered = property(property(exported.expression.arguments[0], 'nitro'), 'tasks')
    expect(object(registered).properties.map(entry => text(entry.name!)).sort()).toEqual(Object.keys(bindings).sort())
    for (const [name, relativeFile] of Object.entries(bindings)) {
      const handler = property(property(registered, name), 'handler')
      if (!ts.isCallExpression(handler) || handler.expression.getText(config) !== 'fileURLToPath') throw new Error('Task handler paths must be absolute URL-based paths.')
      const url = handler.arguments[0]
      if (!url || !ts.isNewExpression(url) || url.expression.getText(config) !== 'URL' || !url.arguments?.[0] || !url.arguments[1]) throw new Error('Task handler must use a bounded config-relative URL.')
      expect(text(url.arguments[0])).toBe(relativeFile)
      expect(url.arguments[1].getText(config)).toBe('import.meta.url')
      const sourcePath = fileURLToPath(new URL(relativeFile, configUrl))
      expect(existsSync(sourcePath)).toBe(true)
      const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const meta = findNode(source, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && text(node.name) === 'meta')
      expect(text(property(meta.initializer, 'name'))).toBe(name)
    }
  })
  it('retains every configured scheduled job and its cron in the real production registry', () => {
    const expected = configuredSchedules()
    expect(expected.flatMap(row => row.tasks)).toHaveLength(11)
    const built = readBuiltMetadata()
    expect(() => assertScheduledRegistration(expected, built)).not.toThrow()
    const taskDirectory = resolve(dirname(productionArtifact), '../tasks')
    for (const row of expected) for (const task of row.tasks) {
      const modulePath = resolve(dirname(productionArtifact), built.registry.get(task)!)
      expect(modulePath.startsWith(`${taskDirectory}${sep}`)).toBe(true)
      expect(existsSync(modulePath)).toBe(true)
    }
    expect(built.schedules.find(row => row.cron === '*/5 * * * *')?.tasks).toContain('weekly-content:tick')
    expect(built.schedules.find(row => row.cron === '*/5 * * * *')?.tasks).toContain('learning-loop:tick')
  })
  it('resolves all five canonical names to the original built handler, without executing it', () => {
    const built = readBuiltMetadata()
    for (const [name, relativeFile] of Object.entries(bindings)) {
      const scannedName = relativeFile.split('/').at(-1)!.replace(/\.ts$/, '')
      expect(built.registry.has(name), name).toBe(true)
      expect(built.registry.get(name)).toBe(built.registry.get(scannedName))
    }
  })
  it('fails if a scheduled canonical name is missing even when its hyphenated file was built', () => {
    const expected = [{ cron: '*/5 * * * *', tasks: ['weekly-content:tick'] }]
    const built = { schedules: expected, registry: new Map([['weekly-content-tick', '../tasks/weekly-content-tick.mjs']]) }
    expect(() => assertScheduledRegistration(expected, built)).toThrow('not registered')
  })
  it('fails if a registered task was silently dropped from cron or registered twice', () => {
    const expected = [{ cron: '*/5 * * * *', tasks: ['weekly-content:tick'] }]
    const registry = new Map([['weekly-content:tick', '../tasks/weekly-content-tick.mjs']])
    expect(() => assertScheduledRegistration(expected, { schedules: [], registry })).toThrow('dropped')
    expect(() => assertScheduledRegistration(expected, { schedules: [expected[0]!, expected[0]!], registry })).toThrow('duplicated')
  })
})
