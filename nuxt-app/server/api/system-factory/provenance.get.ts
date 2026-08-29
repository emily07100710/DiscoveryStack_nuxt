import { systemFactoryOwnerContext } from '../../system-factory/http'
import { FRAPPE_SYSTEM_FACTORY_PROVENANCE } from '../../system-factory/provenance'

export default defineEventHandler(async event => {
  await systemFactoryOwnerContext(event)
  return { provenance: FRAPPE_SYSTEM_FACTORY_PROVENANCE }
})
