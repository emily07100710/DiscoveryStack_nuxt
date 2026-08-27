import { DrizzleGeoOutcomeRepository } from './repository-drizzle'
import { DrizzleModelOpsRepository } from './modelops-repository-drizzle'
import type { GeoOutcomeRepositoryPort } from './types'
import type { ModelOpsRepositoryPort } from './modelops-types'

export function getProductionModelOpsDependencies(): { outcomeRepository: GeoOutcomeRepositoryPort, modelOpsRepository: ModelOpsRepositoryPort } {
  return { outcomeRepository: new DrizzleGeoOutcomeRepository(), modelOpsRepository: new DrizzleModelOpsRepository() }
}
