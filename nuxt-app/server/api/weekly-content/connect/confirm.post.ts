import { confirmWeeklyLiffConnection, weeklyLiffHttpInput, weeklyLiffPublicError } from '../../../weekly-content/liff-service'
export default defineEventHandler(async event => {
  try { const { input, dependencies } = await weeklyLiffHttpInput(event, true); return await confirmWeeklyLiffConnection(input, dependencies) } catch (cause) { weeklyLiffPublicError(cause) }
})
