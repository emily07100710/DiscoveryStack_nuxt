import type { Intervention, InterventionLoopRepository, InterventionStatus } from './types'

export async function listAllInterventions(repository: InterventionLoopRepository, ownerUserId: number, options: { status?: InterventionStatus | InterventionStatus[], pageSize?: number } = {}): Promise<Intervention[]> {
  const pageSize = options.pageSize ?? 200
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer')
  const rows: Intervention[] = []
  let afterId = 0
  while (true) {
    const page = await repository.listInterventionsPage(ownerUserId, { afterId, limit: pageSize, status: options.status })
    if (!page.length) return rows
    for (const row of page) {
      if (row.id <= afterId) throw new Error('Intervention cursor did not advance')
      rows.push(row)
      afterId = row.id
    }
    if (page.length < pageSize) return rows
  }
}
