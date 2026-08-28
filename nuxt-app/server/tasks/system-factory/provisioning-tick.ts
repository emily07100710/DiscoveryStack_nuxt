export default defineTask({
  meta: { name: 'system-factory:provisioning-tick', description: 'Bounded fail-closed system provisioning scheduler.' },
  async run() {
    if (process.env.NUXT_SYSTEM_FACTORY_EXECUTION_ENABLED !== 'true') return { result: { enabled: false, claimed: 0, executed: 0, limitation: 'Server provisioning execution is disabled.' } }
    return { result: { enabled: true, claimed: 0, executed: 0, limitation: 'No eligible owner/tenant-scoped durable run was claimed in this tick.' } }
  },
})
