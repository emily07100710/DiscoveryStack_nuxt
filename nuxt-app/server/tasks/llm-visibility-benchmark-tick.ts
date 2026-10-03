import { runScheduledBenchmarkTick } from '../llm-visibility/benchmark-scheduler'

export default defineTask({
  meta: {
    name: 'llm-visibility:benchmark-tick',
    description: 'Opt-in owner-scoped recovery of one previously approved benchmark, with at most five single-attempt probes.',
  },
  async run() { return { result: await runScheduledBenchmarkTick() } },
})
