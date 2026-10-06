import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getManagedSiteDesignCare } from '../../../managed-sites/design-care'
import { privateManagedSiteHeaders } from '../../../managed-sites/live-connectors/http'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  const access = await requireManagedSiteCustomer(event)
  return getManagedSiteDesignCare(
    access.project.ownerUserId,
    access.project.id,
    { kind: 'customer', membershipId: access.membership.id },
  )
})
