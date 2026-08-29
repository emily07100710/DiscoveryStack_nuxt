import { getTemplateCatalogProjection } from '../../system-factory/catalog'
import { systemFactoryOwnerContext } from '../../system-factory/http'

export default defineEventHandler(async event => {
  await systemFactoryOwnerContext(event)
  return { templates: getTemplateCatalogProjection(), claims: { executableGeneration: false, erpNextCoreFork: false } }
})
