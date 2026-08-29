import { compileSystemSpec } from '../../system-factory/compiler'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../system-factory/http'

export default defineEventHandler(async event => {
  await systemFactoryOwnerContext(event, true)
  const body = await strictSystemFactoryBody(event, ['spec'])
  return { compiledPlan: compileSystemSpec(body.spec), execution: { writes: false, shell: false, migration: false } }
})
