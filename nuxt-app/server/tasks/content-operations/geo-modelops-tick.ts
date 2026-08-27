import { getProductionModelOpsDependencies } from '../../geo-outcome-model/modelops-runtime'
import { runGeoModelOpsTick } from './geo-modelops-tick-core'

export default defineTask({
  meta: {
    name: 'content-operations:geo-modelops-tick',
    description: 'Run bounded, owner-scoped GEO Outcome ModelOps cycles from durable policies and leases.',
  },
  async run() {
    const dependencies = getProductionModelOpsDependencies()
    return { result: await runGeoModelOpsTick(dependencies) }
  },
})
