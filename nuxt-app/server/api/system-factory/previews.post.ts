import { compileSystemSpec } from '../../system-factory/compiler'
import { buildSystemPreview } from '../../system-factory/preview'
import { parseSystemSpec } from '../../system-factory/system-spec'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../system-factory/http'

export default defineEventHandler(async event => {
  await systemFactoryOwnerContext(event, true)
  const body = await strictSystemFactoryBody(event, ['spec', 'version', 'parentPreviewId'])
  const spec = parseSystemSpec(body.spec); const compiled = compileSystemSpec(spec)
  return { preview: buildSystemPreview(spec, compiled, { version: Number(body.version || spec.version), parentPreviewId: typeof body.parentPreviewId === 'string' ? body.parentPreviewId : null }), claims: { deployed: false, paid: false, productionData: false } }
})
