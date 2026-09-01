import { advanceEligibleManagedSiteProvisioning } from '../../managed-sites/live-connectors/provision-advancer'
export default defineTask({ meta: { name: 'managed-sites:provisioning-tick', description: 'Bounded sleep-tolerant managed-site preview and ownership retry advancement.' }, async run() { return { result: await advanceEligibleManagedSiteProvisioning({ limit: 20 }) } } })
