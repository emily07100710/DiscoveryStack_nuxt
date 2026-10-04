import { getWeeklyLiffConnectContext, weeklyLiffHttpInput, weeklyLiffPublicError } from '../../../weekly-content/liff-service'
export default defineEventHandler(async event => {
  try { const { input, dependencies } = await weeklyLiffHttpInput(event); return await getWeeklyLiffConnectContext(input, dependencies) } catch (cause) { weeklyLiffPublicError(cause) }
})
