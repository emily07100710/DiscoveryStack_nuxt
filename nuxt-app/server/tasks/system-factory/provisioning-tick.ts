import { executeProvisioningTask } from '../../system-factory/provisioning-task'

export default defineTask({
  meta: { name: 'system-factory:provisioning-tick', description: 'Bounded fail-closed system provisioning scheduler.' },
  async run() { return { result: await executeProvisioningTask({ enabled: process.env.NUXT_SYSTEM_FACTORY_EXECUTION_ENABLED === 'true' }) } },
})
