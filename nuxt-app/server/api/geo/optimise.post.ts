import { createError, defineEventHandler, readBody } from 'h3'
import { optimiseGeoDocument } from '../../geo/optimise'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const body = await readBody(event)
  if (!body || typeof body.title !== 'string' || typeof body.content !== 'string' || (body.language !== 'en' && body.language !== 'zh-hant')) {
    throw createError({ statusCode: 400, message: '請提供標題、原文與支援的語言。' })
  }
  // V1 only computes an owner-reviewed draft and never writes the source to the database.
  return optimiseGeoDocument({ title: body.title, content: body.content, language: body.language })
})
