import { createError, getQuery } from 'h3'
import { requireManagedSiteCustomer, requireManagedSiteCustomerPermission } from '../../../managed-sites/auth'
import { listManagedSiteContactMessages } from '../../../managed-sites/contact-form/inbox-service'
import { privateManagedSiteHeaders } from '../../../managed-sites/live-connectors/http'

export default defineEventHandler(async event => {
  privateManagedSiteHeaders(event)
  const access = requireManagedSiteCustomerPermission(await requireManagedSiteCustomer(event), 'data:export')
  const query = getQuery(event)
  if (Object.keys(query).some(key => key !== 'beforeId') || query.beforeId !== undefined && (typeof query.beforeId !== 'string' || !/^[1-9][0-9]*$/u.test(query.beforeId))) throw createError({ statusCode: 422, statusMessage: '網站詢問查詢格式不正確。' })
  return listManagedSiteContactMessages({ ownerUserId: access.project.ownerUserId, projectId: access.project.id, role: access.membership.role }, { beforeId: query.beforeId === undefined ? undefined : Number(query.beforeId) })
})
