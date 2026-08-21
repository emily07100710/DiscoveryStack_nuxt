import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  await requireOwner(event)
  const task = await runTask('model-improvement:collect', { payload: { trigger: 'owner_manual' } })
  return task.result
})
