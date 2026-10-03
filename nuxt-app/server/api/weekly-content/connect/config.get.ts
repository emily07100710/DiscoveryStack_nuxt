import { setResponseHeaders } from 'h3'
import { WEEKLY_LIFF_HEADERS, projectWeeklyLiffConfiguration, weeklyLiffConfiguration } from '../../../weekly-content/liff-service'
export default defineEventHandler(event => {
  setResponseHeaders(event, WEEKLY_LIFF_HEADERS)
  return projectWeeklyLiffConfiguration(weeklyLiffConfiguration())
})
